/**
 * Best length per name for the current UTC day. Lives in memory and, when
 * DATABASE_URL is set, in a small Postgres table so it survives instance
 * recycling and is shared across instances.
 */
import pg from "pg";

export interface DailyEntry {
  name: string;
  best: number;
}

export class DailyBoard {
  private day = today();
  private best = new Map<string, number>();
  private pool: pg.Pool | null = null;
  private ready: Promise<void> | null = null;
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
      this.ready = this.load().catch((err) => {
        console.error("[daily] load failed:", err?.message ?? err);
        this.pool = null;
      });
      setInterval(() => void this.flush(), 5000).unref();
    }
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
    for (const r of rows.rows) this.best.set(r.name, Number(r.best));
  }

  private roll(): void {
    const d = today();
    if (d === this.day) return;
    this.day = d;
    this.best.clear();
    this.dirty.clear();
  }

  record(name: string, length: number): void {
    this.roll();
    const key = name.trim();
    if (!key) return;
    const prev = this.best.get(key) ?? 0;
    if (length <= prev) return;
    this.best.set(key, length);
    this.dirty.add(key);
  }

  top(n: number): DailyEntry[] {
    this.roll();
    return [...this.best.entries()]
      .map(([name, best]) => ({ name, best }))
      .sort((a, b) => b.best - a.best)
      .slice(0, n);
  }

  private async flush(): Promise<void> {
    if (!this.pool || this.flushing || !this.dirty.size) return;
    this.flushing = true;
    try {
      await this.ready;
      if (!this.pool) return;
      const names = [...this.dirty];
      this.dirty.clear();
      for (const name of names) {
        await this.pool.query(
          `INSERT INTO agencoil_daily (day, name, best) VALUES ($1, $2, $3)
           ON CONFLICT (day, name) DO UPDATE SET best = GREATEST(agencoil_daily.best, EXCLUDED.best)`,
          [this.day, name, this.best.get(name) ?? 0],
        );
      }
    } catch (err) {
      console.error("[daily] flush failed:", (err as Error)?.message ?? err);
    } finally {
      this.flushing = false;
    }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
