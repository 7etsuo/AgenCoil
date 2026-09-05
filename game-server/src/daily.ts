/**
 * Best length per name for the current UTC day. Lives in memory and, when
 * DATABASE_URL is set, in a small Postgres table so it survives instance
 * recycling and is shared across instances.
 */
import pg from "pg";
import { retryDb } from "./db-retry";

export interface DailyEntry {
  name: string;
  best: number;
}

export class DailyBoard {
  private day = today();
  private best = new Map<string, number>();
  private pool: pg.Pool | null = null;
  private ready: Promise<void> | null = null;
  private initialized = false;
  private dirty = new Set<string>();
  private flushing = false;

  constructor() {
    const url = process.env.DATABASE_URL?.trim();
    if (url) {
      this.pool = new pg.Pool({
        connectionString: url,
        max: 2,
        // Be explicit about verification; pg warns about implicit sslmode.
        ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: true } : undefined,
      });
      void this.ensureReady().catch((err) => {
        console.error("[daily] load failed:", err?.message ?? err);
      });
      setInterval(() => void this.flush(), 5000).unref();
    }
  }

  private ensureReady(): Promise<void> {
    if (!this.pool || this.initialized) return Promise.resolve();
    if (!this.ready) {
      this.ready = retryDb(() => this.load())
        .then(() => {
          this.initialized = true;
        })
        .catch((error) => {
          this.ready = null;
          throw error;
        });
    }
    return this.ready;
  }

  private async load(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS agencoil_daily (
         day DATE NOT NULL, name TEXT NOT NULL, best INTEGER NOT NULL,
         PRIMARY KEY (day, name))`,
    );
    const rows = await this.pool.query<{ name: string; best: number }>(
      `SELECT name, best FROM agencoil_daily WHERE day = $1 ORDER BY best DESC LIMIT 200`,
      [this.day],
    );
    for (const r of rows.rows) {
      this.best.set(r.name, Math.max(this.best.get(r.name) ?? 0, Number(r.best)));
    }
  }

  private roll(): void {
    const d = today();
    if (d === this.day) return;
    this.day = d;
    this.best.clear();
    this.sorted = null;
    this.dirty.clear();
  }

  /** The board as last sorted, until a record changes it. */
  private sorted: DailyEntry[] | null = null;

  record(name: string, length: number): void {
    this.roll();
    const key = name.trim();
    if (!key) return;
    const prev = this.best.get(key) ?? 0;
    if (length <= prev) return;
    this.best.set(key, length);
    this.dirty.add(key);
    this.sorted = null;
    // A name churner must not grow the day's map without bound: past a few
    // thousand names, everything outside the top few hundred is let go.
    if (this.best.size > DAILY_MAX_NAMES) {
      const keep = [...this.best.entries()].sort((a, b) => b[1] - a[1]).slice(0, DAILY_KEEP_NAMES);
      this.best = new Map(keep);
      for (const n of this.dirty) if (!this.best.has(n)) this.dirty.delete(n);
    }
  }

  top(n: number): DailyEntry[] {
    this.roll();
    if (!this.initialized) {
      void this.ensureReady().catch((err) => {
        console.error("[daily] load failed:", err?.message ?? err);
      });
    }
    if (!this.sorted)
      this.sorted = [...this.best.entries()]
        .map(([name, best]) => ({ name, best }))
        .sort((a, b) => b.best - a.best)
        .slice(0, DAILY_KEEP_NAMES);
    return this.sorted.slice(0, n);
  }

  private async flush(): Promise<void> {
    if (!this.pool || this.flushing || !this.dirty.size) return;
    this.flushing = true;
    try {
      await this.ensureReady();
      if (!this.pool) return;
      const day = this.day;
      const jobs = [...this.dirty].map(async (name) => {
        const best = this.best.get(name) ?? 0;
        await retryDb(() =>
          this.pool!.query(
            `INSERT INTO agencoil_daily (day, name, best) VALUES ($1, $2, $3)
             ON CONFLICT (day, name) DO UPDATE SET best = GREATEST(agencoil_daily.best, EXCLUDED.best)`,
            [day, name, best],
          ),
        );
        if (this.day === day && (this.best.get(name) ?? 0) === best) this.dirty.delete(name);
      });
      for (const r of await Promise.allSettled(jobs)) {
        if (r.status === "rejected")
          console.error("[daily] flush failed:", (r.reason as Error)?.message ?? r.reason);
      }
    } catch (err) {
      console.error("[daily] flush failed:", (err as Error)?.message ?? err);
    } finally {
      this.flushing = false;
    }
  }
}

const DAILY_MAX_NAMES = 4000;
const DAILY_KEEP_NAMES = 500;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
