/**
 * The events log: what players do, written by the server so the game can be
 * tuned from numbers instead of guesses. Rows are buffered in memory and
 * flushed in one statement every few seconds; without a database nothing is
 * kept. `runMetrics` answers the retention questions from the same table.
 */
import { retryDb } from "./db-retry.ts";

/** Anything with a `query` in the pg shape: a pool, or PGlite in tests. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface EventFields {
  /** Profile key of the player the event is about ("" for arena-wide events). */
  key?: string;
  /** A short label: the feature used, the death cause, the tier reached. */
  s?: string;
  /** A number: seconds, a length, a bank. */
  n?: number;
  meta?: Record<string, unknown>;
}

interface EventRow {
  at: number;
  kind: string;
  key: string;
  s: string;
  n: number;
  meta: Record<string, unknown>;
}

/** Events kept in memory between flushes; past this the oldest are dropped and counted. */
export const EVENT_BUFFER_MAX = 5000;
const FLUSH_MS = 5000;
const METRICS_CACHE_MS = 60_000;

export class EventLog {
  private readonly buffer: EventRow[] = [];
  /** Events dropped because the buffer was full (reported in the status JSON). */
  dropped = 0;
  private ready: Promise<void> | null = null;
  private initialized = false;
  private flushing = false;
  private metricsCache: { at: number; days: number; value: Metrics } | null = null;

  private readonly pool: Queryable | null;
  private readonly arena: string;
  private readonly now: () => number;

  constructor(pool: Queryable | null, arena: string, now: () => number = Date.now) {
    this.pool = pool;
    this.arena = arena;
    this.now = now;
    if (pool) {
      void this.ensureReady().catch((err) => {
        console.error("[events] init failed:", (err as Error)?.message ?? err);
      });
      setInterval(() => void this.flush(), FLUSH_MS).unref();
    }
  }

  get enabled(): boolean {
    return this.pool !== null;
  }

  get buffered(): number {
    return this.buffer.length;
  }

  /** Record one event. Cheap and never throws; a full buffer drops the oldest. */
  log(kind: string, fields: EventFields = {}, at = this.now()): void {
    if (!this.pool) return;
    this.buffer.push({
      at,
      kind,
      key: fields.key ?? "",
      s: fields.s ?? "",
      n: Number.isFinite(fields.n) ? (fields.n as number) : 0,
      meta: fields.meta ?? {},
    });
    if (this.buffer.length > EVENT_BUFFER_MAX) {
      this.buffer.splice(0, this.buffer.length - EVENT_BUFFER_MAX);
      this.dropped++;
    }
  }

  ensureReady(): Promise<void> {
    if (!this.pool || this.initialized) return Promise.resolve();
    if (!this.ready) {
      this.ready = retryDb(() => ensureEventsTable(this.pool!))
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

  /** Write everything buffered in one round trip; on failure the rows wait for the next try. */
  async flush(): Promise<void> {
    if (!this.pool || this.flushing || !this.buffer.length) return;
    this.flushing = true;
    const rows = this.buffer.splice(0, this.buffer.length);
    try {
      await this.ensureReady();
      await retryDb(() =>
        this.pool!.query(
          `INSERT INTO agencoil_events (at, arena, kind, key, s, n, meta)
           SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::real[], $7::jsonb[])`,
          [
            rows.map((r) => new Date(r.at).toISOString()),
            rows.map(() => this.arena),
            rows.map((r) => r.kind),
            rows.map((r) => r.key),
            rows.map((r) => r.s),
            rows.map((r) => r.n),
            rows.map((r) => JSON.stringify(r.meta)),
          ],
        ),
      );
    } catch (err) {
      console.error("[events] flush failed:", (err as Error)?.message ?? err);
      this.buffer.unshift(...rows);
      if (this.buffer.length > EVENT_BUFFER_MAX) {
        this.dropped += this.buffer.length - EVENT_BUFFER_MAX;
        this.buffer.length = EVENT_BUFFER_MAX;
      }
    } finally {
      this.flushing = false;
    }
  }

  /** The retention readout for the last `days`, cached a minute. */
  async metrics(days = 7): Promise<Metrics | null> {
    if (!this.pool) return null;
    const c = this.metricsCache;
    if (c && c.days === days && this.now() - c.at < METRICS_CACHE_MS) return c.value;
    await this.ensureReady();
    const value = await runMetrics(this.pool, days);
    this.metricsCache = { at: this.now(), days, value };
    return value;
  }
}

export async function ensureEventsTable(q: Queryable): Promise<void> {
  await q.query(`CREATE TABLE IF NOT EXISTS agencoil_events (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    arena TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL DEFAULT '',
    s TEXT NOT NULL DEFAULT '',
    n REAL NOT NULL DEFAULT 0,
    meta JSONB NOT NULL DEFAULT '{}')`);
  await q.query(`CREATE INDEX IF NOT EXISTS agencoil_events_kind ON agencoil_events (kind, at)`);
  await q.query(`CREATE INDEX IF NOT EXISTS agencoil_events_key ON agencoil_events (key, at)`);
}

export interface Metrics {
  days: number;
  /** One row per UTC day, oldest first. */
  daily: { day: string; players: number; newPlayers: number; sessions: number; lives: number }[];
  /** Players first seen in the window who came back the next day / a week later. */
  retention: { cohort: number; d1: number; d1Eligible: number; d7: number; d7Eligible: number };
  sessions: { count: number; medianSecs: number; p90Secs: number; livesPerSession: number };
  deaths: { cause: string; count: number; meanLength: number; meanSurvive: number }[];
  spawns: { kind: string; count: number }[];
  features: { name: string; count: number }[];
  achievements: { id: string; count: number }[];
  leagues: { kind: string; tier: string; count: number }[];
}

/** The readout's queries; `$1` is the window in days. Kept together so the script and the server agree. */
export const METRICS_SQL = {
  daily: `
    WITH first AS (SELECT key, min(at)::date AS d0 FROM agencoil_events WHERE key <> '' GROUP BY key)
    SELECT to_char(e.at::date, 'YYYY-MM-DD') AS day,
           count(DISTINCT e.key) FILTER (WHERE e.key <> '') AS players,
           count(DISTINCT e.key) FILTER (WHERE e.key <> '' AND f.d0 = e.at::date) AS new_players,
           count(*) FILTER (WHERE e.kind = 'session_start') AS sessions,
           count(*) FILTER (WHERE e.kind = 'spawn') AS lives
    FROM agencoil_events e LEFT JOIN first f ON f.key = e.key
    WHERE e.at >= now() - ($1::int * interval '1 day')
    GROUP BY 1 ORDER BY 1`,
  retention: `
    WITH first AS (SELECT key, min(at)::date AS d0 FROM agencoil_events WHERE key <> '' GROUP BY key),
         days AS (SELECT DISTINCT key, at::date AS d FROM agencoil_events WHERE key <> '')
    SELECT count(*) AS cohort,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM days d WHERE d.key = f.key AND d.d = f.d0 + 1)) AS d1,
           count(*) FILTER (WHERE f.d0 <= (now() - interval '1 day')::date) AS d1_eligible,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM days d WHERE d.key = f.key AND d.d = f.d0 + 7)) AS d7,
           count(*) FILTER (WHERE f.d0 <= (now() - interval '7 day')::date) AS d7_eligible
    FROM first f
    WHERE f.d0 >= (now() - ($1::int * interval '1 day'))::date`,
  sessions: `
    SELECT count(*) AS count,
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY n), 0) AS median_secs,
           coalesce(percentile_cont(0.9) WITHIN GROUP (ORDER BY n), 0) AS p90_secs,
           coalesce(avg((meta->>'lives')::real), 0) AS lives_per_session
    FROM agencoil_events
    WHERE kind = 'session_end' AND at >= now() - ($1::int * interval '1 day')`,
  deaths: `
    SELECT s AS cause, count(*) AS count, coalesce(avg(n), 0) AS mean_length,
           coalesce(avg((meta->>'survive')::real), 0) AS mean_survive
    FROM agencoil_events
    WHERE kind = 'death' AND at >= now() - ($1::int * interval '1 day')
    GROUP BY s ORDER BY count DESC`,
  spawns: `
    SELECT s AS kind, count(*) AS count FROM agencoil_events
    WHERE kind = 'spawn' AND at >= now() - ($1::int * interval '1 day')
    GROUP BY s ORDER BY count DESC`,
  features: `
    SELECT s AS name, count(*) AS count FROM agencoil_events
    WHERE kind = 'feature' AND at >= now() - ($1::int * interval '1 day')
    GROUP BY s ORDER BY count DESC`,
  achievements: `
    SELECT s AS id, count(*) AS count FROM agencoil_events
    WHERE kind = 'achievement' AND at >= now() - ($1::int * interval '1 day')
    GROUP BY s ORDER BY count DESC LIMIT 20`,
  leagues: `
    SELECT kind, s AS tier, count(*) AS count FROM agencoil_events
    WHERE kind IN ('promoted', 'banked', 'season_banked') AND at >= now() - ($1::int * interval '1 day')
    GROUP BY kind, s ORDER BY kind, tier`,
} as const;

const num = (v: unknown): number => Number(v) || 0;

export async function runMetrics(q: Queryable, days = 7): Promise<Metrics> {
  const p = [days];
  const [daily, retention, sessions, deaths, spawns, features, achievements, leagues] =
    await Promise.all([
      q.query(METRICS_SQL.daily, p),
      q.query(METRICS_SQL.retention, p),
      q.query(METRICS_SQL.sessions, p),
      q.query(METRICS_SQL.deaths, p),
      q.query(METRICS_SQL.spawns, p),
      q.query(METRICS_SQL.features, p),
      q.query(METRICS_SQL.achievements, p),
      q.query(METRICS_SQL.leagues, p),
    ]);
  const r = retention.rows[0] ?? {};
  const s = sessions.rows[0] ?? {};
  return {
    days,
    daily: daily.rows.map((x) => ({
      day: String(x.day),
      players: num(x.players),
      newPlayers: num(x.new_players),
      sessions: num(x.sessions),
      lives: num(x.lives),
    })),
    retention: {
      cohort: num(r.cohort),
      d1: num(r.d1),
      d1Eligible: num(r.d1_eligible),
      d7: num(r.d7),
      d7Eligible: num(r.d7_eligible),
    },
    sessions: {
      count: num(s.count),
      medianSecs: num(s.median_secs),
      p90Secs: num(s.p90_secs),
      livesPerSession: num(s.lives_per_session),
    },
    deaths: deaths.rows.map((x) => ({
      cause: String(x.cause),
      count: num(x.count),
      meanLength: num(x.mean_length),
      meanSurvive: num(x.mean_survive),
    })),
    spawns: spawns.rows.map((x) => ({ kind: String(x.kind), count: num(x.count) })),
    features: features.rows.map((x) => ({ name: String(x.name), count: num(x.count) })),
    achievements: achievements.rows.map((x) => ({ id: String(x.id), count: num(x.count) })),
    leagues: leagues.rows.map((x) => ({
      kind: String(x.kind),
      tier: String(x.tier),
      count: num(x.count),
    })),
  };
}

/** A plain-text report of the readout, for the metrics script. */
export function formatMetrics(m: Metrics): string {
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
  const lines: string[] = [];
  lines.push(`last ${m.days} days`);
  lines.push("");
  lines.push("day         players  new  sessions  lives");
  for (const d of m.daily)
    lines.push(
      `${d.day}  ${String(d.players).padStart(7)}  ${String(d.newPlayers).padStart(3)}  ${String(d.sessions).padStart(8)}  ${String(d.lives).padStart(5)}`,
    );
  lines.push("");
  lines.push(
    `retention: cohort ${m.retention.cohort}, D1 ${pct(m.retention.d1, m.retention.d1Eligible)} (${m.retention.d1}/${m.retention.d1Eligible}), D7 ${pct(m.retention.d7, m.retention.d7Eligible)} (${m.retention.d7}/${m.retention.d7Eligible})`,
  );
  lines.push(
    `sessions: ${m.sessions.count}, median ${Math.round(m.sessions.medianSecs)} s, p90 ${Math.round(m.sessions.p90Secs)} s, ${m.sessions.livesPerSession.toFixed(1)} lives each`,
  );
  lines.push("");
  lines.push("deaths");
  for (const d of m.deaths)
    lines.push(
      `  ${d.cause.padEnd(8)} ${String(d.count).padStart(6)}  mean length ${Math.round(d.meanLength)}  mean life ${Math.round(d.meanSurvive)} s`,
    );
  lines.push("spawns");
  for (const x of m.spawns) lines.push(`  ${x.kind.padEnd(8)} ${String(x.count).padStart(6)}`);
  lines.push("features");
  for (const x of m.features) lines.push(`  ${x.name.padEnd(12)} ${String(x.count).padStart(6)}`);
  lines.push("achievements");
  for (const x of m.achievements) lines.push(`  ${x.id.padEnd(16)} ${String(x.count).padStart(6)}`);
  lines.push("leagues");
  for (const x of m.leagues)
    lines.push(`  ${x.kind.padEnd(14)} ${x.tier.padEnd(9)} ${String(x.count).padStart(6)}`);
  return lines.join("\n");
}
