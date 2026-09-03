/**
 * Persistent player profiles keyed by a device key the client generates.
 * Held in memory for the life of the instance and, when DATABASE_URL is
 * set, upserted to Postgres so they survive instance recycling and are
 * shared across instances.
 */
import pg from "pg";
import {
  dailyChallenges,
  lifeValue,
  todayUtc,
  type Challenge,
  type LifeStats,
} from "../../src/game/challenges";

export interface Profile {
  key: string;
  name: string;
  best: number;
  kills: number;
  games: number;
  /** Longest single life, in seconds. */
  survive: number;
  /** Cosmetic unlock bitmask (see challenges.ts). */
  unlocks: number;
  day: string;
  progress: number[];
  done: boolean[];
}

export interface ChallengeView {
  challenge: Challenge;
  progress: number;
  done: boolean;
}

export class ProfileStore {
  private readonly cache = new Map<string, Profile>();
  private readonly dirty = new Set<string>();
  private pool: pg.Pool | null = null;
  private ready: Promise<void> | null = null;
  private flushing = false;

  constructor() {
    const url = process.env.DATABASE_URL?.trim();
    if (url) {
      this.pool = new pg.Pool({
        connectionString: url,
        max: 2,
        ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: true } : undefined,
      });
      this.ready = this.pool
        .query(
          `CREATE TABLE IF NOT EXISTS agencoil_profiles (
             key TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
             best INTEGER NOT NULL DEFAULT 0, kills INTEGER NOT NULL DEFAULT 0,
             games INTEGER NOT NULL DEFAULT 0, survive INTEGER NOT NULL DEFAULT 0,
             unlocks INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL DEFAULT '',
             progress JSONB NOT NULL DEFAULT '[]', updated TIMESTAMPTZ NOT NULL DEFAULT now())`,
        )
        .then(() => undefined)
        .catch((err) => {
          console.error("[profiles] init failed:", (err as Error)?.message ?? err);
          this.pool = null;
        });
      setInterval(() => void this.flush(), 5000).unref();
    }
  }

  get persistent(): boolean {
    return this.pool !== null;
  }

  private fresh(key: string, name: string): Profile {
    return {
      key,
      name,
      best: 0,
      kills: 0,
      games: 0,
      survive: 0,
      unlocks: 0,
      day: todayUtc(),
      progress: [0, 0, 0],
      done: [false, false, false],
    };
  }

  async load(key: string, name: string): Promise<Profile> {
    const cached = this.cache.get(key);
    if (cached) {
      cached.name = name;
      this.rollDay(cached);
      return cached;
    }
    let p = this.fresh(key, name);
    if (this.pool) {
      try {
        await this.ready;
        const rows = await this.pool.query<{
          name: string;
          best: number;
          kills: number;
          games: number;
          survive: number;
          unlocks: number;
          day: string;
          progress: unknown;
        }>(
          `SELECT name, best, kills, games, survive, unlocks, day, progress FROM agencoil_profiles WHERE key = $1`,
          [key],
        );
        const r = rows.rows[0];
        if (r) {
          const prog = Array.isArray(r.progress) ? (r.progress as unknown[]) : [];
          p = {
            key,
            name,
            best: Number(r.best),
            kills: Number(r.kills),
            games: Number(r.games),
            survive: Number(r.survive),
            unlocks: Number(r.unlocks),
            day: r.day,
            progress: [0, 1, 2].map((i) => Number(prog[i] ?? 0)),
            done: [0, 1, 2].map((i) => Number(prog[i + 3] ?? 0) === 1),
          };
        }
      } catch (err) {
        console.error("[profiles] load failed:", (err as Error)?.message ?? err);
      }
    }
    this.rollDay(p);
    this.cache.set(key, p);
    return p;
  }

  private rollDay(p: Profile): void {
    const today = todayUtc();
    if (p.day === today) return;
    p.day = today;
    p.progress = [0, 0, 0];
    p.done = [false, false, false];
    this.dirty.add(p.key);
  }

  challenges(p: Profile): ChallengeView[] {
    this.rollDay(p);
    return dailyChallenges(p.day).map((c, i) => ({
      challenge: c,
      progress: p.progress[i] ?? 0,
      done: p.done[i] ?? false,
    }));
  }

  /** Fold a finished life into the profile; returns challenges completed by it. */
  recordLife(p: Profile, life: LifeStats): Challenge[] {
    this.rollDay(p);
    p.games++;
    p.kills += life.kills;
    if (life.length > p.best) p.best = life.length;
    if (life.survive > p.survive) p.survive = Math.floor(life.survive);
    const completed: Challenge[] = [];
    dailyChallenges(p.day).forEach((c, i) => {
      const v = Math.min(c.target, Math.floor(lifeValue(c, life)));
      if (v > (p.progress[i] ?? 0)) p.progress[i] = v;
      if (!p.done[i] && v >= c.target) {
        p.done[i] = true;
        p.unlocks |= c.unlock;
        completed.push(c);
      }
    });
    this.dirty.add(p.key);
    return completed;
  }

  /** All-time rank by best length (1 = longest ever). */
  async rank(p: Profile): Promise<number> {
    if (this.pool && p.best > 0) {
      try {
        await this.ready;
        const r = await this.pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM agencoil_profiles WHERE best > $1`,
          [p.best],
        );
        return Number(r.rows[0]?.n ?? 0) + 1;
      } catch {
        /* fall through to the in-memory estimate */
      }
    }
    let above = 0;
    for (const o of this.cache.values()) if (o.best > p.best) above++;
    return above + 1;
  }

  private async flush(): Promise<void> {
    if (!this.pool || this.flushing || !this.dirty.size) return;
    this.flushing = true;
    try {
      await this.ready;
      if (!this.pool) return;
      const keys = [...this.dirty];
      this.dirty.clear();
      for (const key of keys) {
        const p = this.cache.get(key);
        if (!p) continue;
        await this.pool.query(
          `INSERT INTO agencoil_profiles (key, name, best, kills, games, survive, unlocks, day, progress, updated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, best = GREATEST(agencoil_profiles.best, EXCLUDED.best),
             kills = EXCLUDED.kills, games = EXCLUDED.games, survive = GREATEST(agencoil_profiles.survive, EXCLUDED.survive),
             unlocks = agencoil_profiles.unlocks | EXCLUDED.unlocks, day = EXCLUDED.day, progress = EXCLUDED.progress, updated = now()`,
          [
            p.key,
            p.name,
            p.best,
            p.kills,
            p.games,
            p.survive,
            p.unlocks,
            p.day,
            JSON.stringify([...p.progress, ...p.done.map((d) => (d ? 1 : 0))]),
          ],
        );
      }
    } catch (err) {
      console.error("[profiles] flush failed:", (err as Error)?.message ?? err);
    } finally {
      this.flushing = false;
    }
  }
}
