/**
 * The arena coordinator. A Vercel function cannot hold every player's socket
 * (connections spread across instances), so the world runs as one process
 * inside a Vercel Sandbox and this module, running in the function, keeps
 * that Sandbox alive, hands clients its address, rolls a fresh one before the
 * session limit and opens a second arena only when the first is full.
 *
 * State lives in Postgres so every function instance agrees; without a
 * database (local dev) the coordinator is disabled and clients connect to
 * the function directly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { Sandbox } from "@vercel/sandbox";
import { MAX_PLAYERS_PER_INSTANCE } from "../../src/game/model";
import { retryDb } from "./db-retry";

export interface ArenaRow {
  name: string;
  domain: string;
  createdAt: number;
  expiresAt: number;
  /** The function deployment whose bundle this arena runs. */
  build: string;
}

export interface ArenaHealth {
  ok: boolean;
  players: number;
  /** Players the arena admits, as it reports; absent from older arenas. */
  capacity?: number;
  at: number;
}

/** Room left on an arena, by its own reported capacity. */
export function hasRoom(h: ArenaHealth, max = MAX_PLAYERS_PER_INSTANCE): boolean {
  return h.players < (h.capacity ?? max);
}

/** Session length asked of the Sandbox, and how long before expiry to roll. */
export const ARENA_SESSION_MS = 23 * 3600_000;
/**
 * Arenas registered by hand (a machine you run, reached through a tunnel)
 * carry this build tag. The coordinator health-checks and places players on
 * them like any other arena but never rolls, drains or forgets them; a
 * Sandbox is only created when every static arena is down or full.
 */
export const STATIC_BUILD = "static";
export const isStatic = (r: { build: string }): boolean => r.build === STATIC_BUILD;
export const ARENA_ROLL_BEFORE_MS = 90 * 60_000;
/**
 * An arena row younger than this whose probe fails is booting, not dead: a
 * fresh Sandbox answers its first requests slowly or not at all. Lookups
 * wait for it instead of starting another, and the tick keeps its row.
 */
export const ARENA_BOOT_MS = 120_000;
/** How long one lookup waits on a booting arena before answering with it anyway. */
const BOOT_WAIT_MS = 5000;
/** Ticks closer together than this answer with the last result: the endpoint is public. */
const TICK_MIN_MS = 15_000;
/**
 * A running arena Sandbox with no row is stopped once it is this old. A
 * create in progress has no row until its first probe answers, so a young
 * one is left alone.
 */
const SANDBOX_ORPHAN_MS = 5 * 60_000;
const ARENA_PREFIX = "snek-arena-";

/**
 * What the coordinator does to arena Sandboxes beyond creating them. Every
 * Sandbox runs until its session times out (23 hours) unless it is stopped,
 * and a roll happens on every deploy, so an arena that is drained or
 * forgotten must be stopped or the Sandboxes pile up, each billed for its
 * memory the whole time. A test passes a stub.
 */
export interface SandboxControl {
  /** Stop a Sandbox by name; one that is gone or already stopped is fine. */
  stop(name: string): Promise<void>;
  /** Every running Sandbox tagged as this app's, with its creation time in ms. */
  running(): Promise<{ name: string; createdAt: number }[]>;
}

function sdkSandboxes(): SandboxControl {
  return {
    async stop(name) {
      const s = await Sandbox.get({ name });
      await s.stop();
    },
    async running() {
      const out: { name: string; createdAt: number }[] = [];
      const list = await Sandbox.list({ tags: { app: "snek" } });
      for await (const s of list) {
        if (s.status !== "running") continue;
        // Defensive about the unit: an epoch in seconds is under 1e12.
        const at = s.createdAt < 1e12 ? s.createdAt * 1000 : s.createdAt;
        out.push({ name: s.name, createdAt: at });
      }
      return out;
    },
  };
}
const HEALTH_TTL_MS = 10_000;
/** Lookups reuse the arena rows for this long: a roll makes every client ask again within a second. */
const ROWS_TTL_MS = 2000;
const LOCK_MS = 60_000;
const PARTY_ROUTE_MS = 15 * 60_000;
const ARENA_PORT = 8080;

/** Pick the arena for a client: its party's arena if live, else the oldest with room. */
export function pickArena(
  arenas: (ArenaRow & { health: ArenaHealth })[],
  partyArena: string | null,
  max = MAX_PLAYERS_PER_INSTANCE,
): ArenaRow | null {
  const live = arenas.filter((a) => a.health.ok).sort((a, b) => a.createdAt - b.createdAt);
  if (!live.length) return null;
  if (partyArena) {
    const p = live.find((a) => a.name === partyArena);
    if (p) return p;
  }
  return live.find((a) => hasRoom(a.health, max)) ?? live[live.length - 1]!;
}

export class ArenaHost {
  readonly enabled: boolean;
  private readonly health = new Map<string, ArenaHealth>();
  private lastTick = 0;
  /** The last completed tick's answer and time, for callers asking again too soon. */
  private lastTickResult: {
    at: number;
    result: { arenas: number; created: boolean; drained: string[] };
  } | null = null;
  /** Rows from the last database read, for synchronous checks, and when they were read. */
  private lastRows: ArenaRow[] = [];
  private lastRowsAt = 0;
  private ready: Promise<void> | null = null;
  /** Sandbox control; null where there is no token to call the API with (tests, local runs). */
  private readonly sandboxes: SandboxControl | null;

  constructor(
    private readonly pool: pg.Pool | null,
    private readonly env: Record<string, string | undefined>,
    sandboxes?: SandboxControl,
  ) {
    this.enabled = Boolean(pool && env.VERCEL);
    this.sandboxes =
      sandboxes ?? (env.VERCEL_OIDC_TOKEN || env.VERCEL_TOKEN ? sdkSandboxes() : null);
  }

  /** Tables exist; a failed attempt (cold Neon connection) is retried next call. */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = retryDb(() => this.init()).catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  private q<T extends object = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    return retryDb(() => this.pool!.query<T>(text, params), { attempts: 3, baseDelayMs: 200 });
  }

  private async init(): Promise<void> {
    await this.pool!.query(`CREATE TABLE IF NOT EXISTS agencoil_arena (
      name TEXT PRIMARY KEY, domain TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`);
    await this.pool!.query(
      `ALTER TABLE agencoil_arena ADD COLUMN IF NOT EXISTS build TEXT NOT NULL DEFAULT ''`,
    );
    await this.pool!.query(
      `CREATE TABLE IF NOT EXISTS agencoil_arena_lock (id INTEGER PRIMARY KEY, until BIGINT NOT NULL)`,
    );
    await this.pool!.query(
      `INSERT INTO agencoil_arena_lock (id, until) VALUES (1, 0) ON CONFLICT DO NOTHING`,
    );
    await this.pool!.query(
      `CREATE TABLE IF NOT EXISTS agencoil_party_route (code TEXT PRIMARY KEY, name TEXT NOT NULL, until BIGINT NOT NULL)`,
    );
  }

  /** The socket URL a client should dial, or null when the coordinator is off. */
  async resolve(party: string): Promise<{ url: string; name: string } | null> {
    if (!this.enabled) return null;
    await this.ensureReady();
    const now = Date.now();
    if (now - this.lastTick > 60_000) {
      this.lastTick = now;
      void this.tick().catch(() => undefined);
    }
    let arenas = await this.liveArenas();
    const ready = (list: { health: ArenaHealth }[]): boolean =>
      list.some((a) => a.health.ok && hasRoom(a.health));
    let booting: ArenaRow | null = null;
    if (!ready(arenas)) {
      // A row created moments ago is still coming up. Starting another
      // arena here is how two ended up running side by side; wait for it
      // instead, and if it is still quiet send the player there anyway,
      // since the client retries and asks again.
      booting = arenas.find((a) => isBooting(a, now)) ?? null;
      if (booting) arenas = await this.awaitBoot(booting, arenas);
      else {
        const made = await this.createArena();
        if (made) arenas = await this.liveArenas();
      }
    }
    const routed = party ? await this.partyRoute(party) : null;
    const pick = pickArena(arenas, routed) ?? booting;
    if (!pick) return null;
    if (party && routed !== pick.name) await this.setPartyRoute(party, pick.name);
    return { url: `${pick.domain.replace(/^https:/, "wss:")}/api/ws`, name: pick.name };
  }

  /** Maintenance: roll arenas near expiry, drop dead ones. Safe to call often. */
  async tick(): Promise<{ arenas: number; created: boolean; drained: string[] }> {
    if (!this.enabled) return { arenas: 0, created: false, drained: [] };
    const now = Date.now();
    const last = this.lastTickResult;
    if (last && now - last.at < TICK_MIN_MS) return last.result;
    const result = await this.tickNow(now);
    this.lastTickResult = { at: Date.now(), result };
    return result;
  }

  private async tickNow(
    now: number,
  ): Promise<{ arenas: number; created: boolean; drained: string[] }> {
    await this.ensureReady();
    // Party routes are written by a public endpoint; expired ones are let go here.
    await this.q(`DELETE FROM agencoil_party_route WHERE until < $1`, [now]).catch(() => undefined);
    const rows = await this.rows(true);
    let created = false;
    const drained: string[] = [];
    const build = this.build;
    // Every row's health first, so a stale arena whose successor is already
    // up drains in this tick rather than the next: each tick of overlap is
    // a second Sandbox running.
    for (const r of rows) await this.checkHealth(r);
    for (const r of rows) {
      const h = await this.checkHealth(r);
      // A static arena is someone's machine: leave its row alone when it is
      // down (players simply are not sent there) and never roll it.
      if (isStatic(r)) continue;
      if (!h.ok && now - r.createdAt > ARENA_BOOT_MS) {
        // Unreachable and not just booting: forget it, and stop what may
        // still be running behind it.
        await this.q(`DELETE FROM agencoil_arena WHERE name = $1`, [r.name]);
        await this.stopSandbox(r.name);
        continue;
      }
      // Roll an arena that is near its session end, or that runs an older
      // bundle than this function: a push reaches the world within a tick.
      const stale = r.build !== build;
      if (stale || r.expiresAt - now < ARENA_ROLL_BEFORE_MS) {
        // Somewhere for its players to go: a fresh Sandbox on this build, or
        // a healthy static arena, in which case no successor is needed.
        const successor = rows.find(
          (o) =>
            o.name !== r.name &&
            (isStatic(o) ||
              (o.createdAt > r.createdAt &&
                o.build === build &&
                o.expiresAt - now > ARENA_ROLL_BEFORE_MS)),
        );
        // One successor per tick serves every stale arena (a deploy makes
        // them all stale at once); they drain into it on the next tick.
        if (!successor) {
          if (!created) created = await this.createArena();
        } else if (this.health.get(successor.name)?.ok) {
          await this.drain(r);
          drained.push(r.name);
        } else if (!isStatic(successor)) {
          /* the successor is still booting: wait for the next tick */
        } else if (!created) {
          created = await this.createArena();
        }
      }
    }
    await this.sweepSandboxes(rows, now);
    return { arenas: rows.length, created, drained };
  }

  /**
   * Stop every running arena Sandbox no row names: what a roll drained, a
   * create that failed after starting, a row deleted by another instance.
   * Rows are the truth; a Sandbox without one serves nobody.
   */
  private async sweepSandboxes(rows: ArenaRow[], now: number): Promise<void> {
    if (!this.sandboxes) return;
    try {
      const named = new Set(rows.map((r) => r.name));
      for (const s of await this.sandboxes.running()) {
        if (!s.name.startsWith(ARENA_PREFIX) || named.has(s.name)) continue;
        if (now - s.createdAt < SANDBOX_ORPHAN_MS) continue;
        await this.stopSandbox(s.name);
      }
    } catch (err) {
      console.error("[arena] sandbox sweep failed:", (err as Error)?.message ?? err);
    }
  }

  private async stopSandbox(name: string): Promise<void> {
    if (!this.sandboxes || !name.startsWith(ARENA_PREFIX)) return;
    try {
      await this.sandboxes.stop(name);
    } catch (err) {
      console.error(`[arena] stopping ${name} failed:`, (err as Error)?.message ?? err);
    }
  }

  /** The deployment this function runs; arenas built from another are rolled. */
  private get build(): string {
    return this.env.VERCEL_DEPLOYMENT_ID ?? "local";
  }

  private async rows(fresh = false): Promise<ArenaRow[]> {
    const now = Date.now();
    if (!fresh && this.lastRowsAt && now - this.lastRowsAt < ROWS_TTL_MS) return this.lastRows;
    const res = await this.q<{
      name: string;
      domain: string;
      created_at: string;
      expires_at: string;
      build: string;
    }>(
      `SELECT name, domain, created_at, expires_at, build FROM agencoil_arena WHERE expires_at > $1 ORDER BY created_at ASC`,
      [Date.now()],
    );
    this.lastRows = res.rows.map((r) => ({
      name: r.name,
      domain: r.domain,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      build: r.build ?? "",
    }));
    this.lastRowsAt = Date.now();
    return this.lastRows;
  }

  /**
   * An arena this instance recently saw healthy with room, without any I/O.
   * Null when nothing is known yet, in which case the function may host.
   */
  knownArena(): ArenaRow | null {
    if (!this.enabled) return null;
    const now = Date.now();
    const live: (ArenaRow & { health: ArenaHealth })[] = [];
    for (const r of this.lastRows) {
      const h = this.health.get(r.name);
      if (r.expiresAt > now && h && h.ok && now - h.at < HEALTH_TTL_MS * 6)
        live.push({ ...r, health: h });
    }
    return pickArena(live, null);
  }

  /**
   * Probe a booting arena afresh, past the health cache, for a few seconds.
   * Once it answers the list is re-read so placement sees it healthy.
   */
  private async awaitBoot(
    row: ArenaRow,
    arenas: (ArenaRow & { health: ArenaHealth })[],
  ): Promise<(ArenaRow & { health: ArenaHealth })[]> {
    const until = Date.now() + BOOT_WAIT_MS;
    for (;;) {
      const h = await probe(row.domain);
      this.health.set(row.name, h);
      if (h.ok) return this.liveArenas(true);
      if (Date.now() >= until) return arenas;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async liveArenas(fresh = false): Promise<(ArenaRow & { health: ArenaHealth })[]> {
    const rows = await this.rows(fresh);
    return Promise.all(rows.map(async (r) => ({ ...r, health: await this.checkHealth(r) })));
  }

  private async checkHealth(r: ArenaRow): Promise<ArenaHealth> {
    const cached = this.health.get(r.name);
    if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached;
    const h = await probe(r.domain);
    this.health.set(r.name, h);
    return h;
  }

  private async partyRoute(code: string): Promise<string | null> {
    const res = await this.pool!.query<{ name: string }>(
      `SELECT name FROM agencoil_party_route WHERE code = $1 AND until > $2`,
      [code, Date.now()],
    );
    return res.rows[0]?.name ?? null;
  }

  private async setPartyRoute(code: string, name: string): Promise<void> {
    await this.q(
      `INSERT INTO agencoil_party_route (code, name, until) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, until = EXCLUDED.until`,
      [code, name, Date.now() + PARTY_ROUTE_MS],
    );
  }

  /** Create one arena under a lease so parallel function instances make only one. */
  private async createArena(): Promise<boolean> {
    const now = Date.now();
    const lock = await this.q(
      `UPDATE agencoil_arena_lock SET until = $1 WHERE id = 1 AND until < $2 RETURNING id`,
      [now + LOCK_MS, now],
    );
    if (!lock.rowCount) {
      // Someone else is creating: wait for their row to become healthy.
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const arenas = await this.liveArenas(true);
        if (arenas.some((a) => a.health.ok && a.createdAt > now - LOCK_MS)) return true;
      }
      return false;
    }
    try {
      const name = `${ARENA_PREFIX}${now.toString(36)}`;
      const sandbox = await Sandbox.create({
        name,
        timeout: ARENA_SESSION_MS,
        ports: [ARENA_PORT],
        region: "iad1",
        resources: { vcpus: 1 },
        persistent: false,
        tags: { app: "snek", role: "arena" },
      });
      const bundle = readFileSync(fileURLToPath(import.meta.url));
      const runner = `import s from "./index.mjs"; s.listen(${ARENA_PORT}, () => console.log("arena listening"));`;
      await sandbox.writeFiles([
        { path: "index.mjs", content: bundle },
        { path: "run.mjs", content: Buffer.from(runner) },
        { path: "package.json", content: Buffer.from('{"type":"module"}') },
      ]);
      const pass = [
        "GAME_SECRET",
        "DATABASE_URL",
        "TURNSTILE_SECRET_KEY",
        "TURNSTILE_ACTION",
        "TURNSTILE_HOSTNAMES",
      ];
      const env: Record<string, string> = {
        PORT: String(ARENA_PORT),
        NODE_ENV: "production",
        ARENA_NAME: name,
      };
      for (const k of pass) if (this.env[k]) env[k] = this.env[k]!;
      await sandbox.runCommand({ cmd: "node", args: ["run.mjs"], detached: true, env });
      const domain = sandbox.domain(ARENA_PORT).replace(/\/$/, "");
      let ok = false;
      for (let i = 0; i < 30; i++) {
        const h = await probe(domain);
        if (h.ok) {
          ok = true;
          this.health.set(name, h);
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!ok) {
        await sandbox.stop().catch(() => undefined);
        return false;
      }
      const expiresAt = sandbox.expiresAt?.getTime() ?? now + ARENA_SESSION_MS;
      await this.q(
        `INSERT INTO agencoil_arena (name, domain, created_at, expires_at, build) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name) DO UPDATE SET domain = EXCLUDED.domain, expires_at = EXCLUDED.expires_at, build = EXCLUDED.build`,
        [name, domain, now, expiresAt, this.build],
      );
      return true;
    } catch (err) {
      console.error("[arena] create failed:", (err as Error)?.message ?? err);
      return false;
    } finally {
      await this.q(`UPDATE agencoil_arena_lock SET until = 0 WHERE id = 1`).catch(() => undefined);
    }
  }

  /** Ask an old arena to send its players to the coordinator, forget it, and stop its Sandbox. */
  private async drain(r: ArenaRow): Promise<void> {
    try {
      await fetch(`${r.domain}/api/drain`, {
        method: "POST",
        headers: { "x-game-secret": this.env.GAME_SECRET ?? "" },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* it may already be gone */
    }
    await this.q(`DELETE FROM agencoil_arena WHERE name = $1`, [r.name]);
    this.health.delete(r.name);
    await this.stopSandbox(r.name);
  }
}

/** A Sandbox arena that is not answering yet but was created only moments ago. */
function isBooting(a: ArenaRow & { health: ArenaHealth }, now: number): boolean {
  return !a.health.ok && !isStatic(a) && now - a.createdAt < ARENA_BOOT_MS;
}

async function probe(domain: string): Promise<ArenaHealth> {
  try {
    const res = await fetch(`${domain}/api/ws`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { ok: false, players: 0, at: Date.now() };
    const j = (await res.json()) as {
      ok?: boolean;
      players?: number;
      capacity?: number;
      draining?: boolean;
    };
    const capacity = Number(j.capacity);
    return {
      ok: Boolean(j.ok) && !j.draining,
      players: Number(j.players) || 0,
      ...(Number.isFinite(capacity) && capacity >= 1 ? { capacity } : {}),
      at: Date.now(),
    };
  } catch {
    return { ok: false, players: 0, at: Date.now() };
  }
}
