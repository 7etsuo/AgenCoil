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

export interface ArenaRow {
  name: string;
  domain: string;
  createdAt: number;
  expiresAt: number;
}

export interface ArenaHealth {
  ok: boolean;
  players: number;
  at: number;
}

/** Session length asked of the Sandbox, and how long before expiry to roll. */
export const ARENA_SESSION_MS = 23 * 3600_000;
export const ARENA_ROLL_BEFORE_MS = 90 * 60_000;
const HEALTH_TTL_MS = 10_000;
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
  return live.find((a) => a.health.players < max) ?? live[live.length - 1]!;
}

export class ArenaHost {
  readonly enabled: boolean;
  private readonly health = new Map<string, ArenaHealth>();
  private lastTick = 0;
  private ready: Promise<void>;

  constructor(
    private readonly pool: pg.Pool | null,
    private readonly env: Record<string, string | undefined>,
  ) {
    this.enabled = Boolean(pool && env.VERCEL);
    this.ready = this.enabled ? this.init() : Promise.resolve();
  }

  private async init(): Promise<void> {
    await this.pool!.query(`CREATE TABLE IF NOT EXISTS agencoil_arena (
      name TEXT PRIMARY KEY, domain TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`);
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
    await this.ready;
    const now = Date.now();
    if (now - this.lastTick > 60_000) {
      this.lastTick = now;
      void this.tick().catch(() => undefined);
    }
    let arenas = await this.liveArenas();
    if (
      !arenas.some((a) => a.health.ok) ||
      arenas.every((a) => !a.health.ok || a.health.players >= MAX_PLAYERS_PER_INSTANCE)
    ) {
      const made = await this.createArena();
      if (made) arenas = await this.liveArenas();
    }
    const routed = party ? await this.partyRoute(party) : null;
    const pick = pickArena(arenas, routed);
    if (!pick) return null;
    if (party && routed !== pick.name) await this.setPartyRoute(party, pick.name);
    return { url: `${pick.domain.replace(/^https:/, "wss:")}/api/ws`, name: pick.name };
  }

  /** Maintenance: roll arenas near expiry, drop dead ones. Safe to call often. */
  async tick(): Promise<{ arenas: number; created: boolean; drained: string[] }> {
    if (!this.enabled) return { arenas: 0, created: false, drained: [] };
    await this.ready;
    const now = Date.now();
    const rows = await this.rows();
    let created = false;
    const drained: string[] = [];
    for (const r of rows) {
      const h = await this.checkHealth(r);
      if (!h.ok && now - r.createdAt > 120_000) {
        // Unreachable and not just booting: forget it.
        await this.pool!.query(`DELETE FROM agencoil_arena WHERE name = $1`, [r.name]);
        continue;
      }
      if (r.expiresAt - now < ARENA_ROLL_BEFORE_MS) {
        const younger = rows.find(
          (o) =>
            o.name !== r.name &&
            o.createdAt > r.createdAt &&
            o.expiresAt - now > ARENA_ROLL_BEFORE_MS,
        );
        if (!younger) {
          created = (await this.createArena()) || created;
        } else if (this.health.get(younger.name)?.ok) {
          await this.drain(r);
          drained.push(r.name);
        }
      }
    }
    return { arenas: rows.length, created, drained };
  }

  private async rows(): Promise<ArenaRow[]> {
    const res = await this.pool!.query<{
      name: string;
      domain: string;
      created_at: string;
      expires_at: string;
    }>(
      `SELECT name, domain, created_at, expires_at FROM agencoil_arena WHERE expires_at > $1 ORDER BY created_at ASC`,
      [Date.now()],
    );
    return res.rows.map((r) => ({
      name: r.name,
      domain: r.domain,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
    }));
  }

  private async liveArenas(): Promise<(ArenaRow & { health: ArenaHealth })[]> {
    const rows = await this.rows();
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
    await this.pool!.query(
      `INSERT INTO agencoil_party_route (code, name, until) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, until = EXCLUDED.until`,
      [code, name, Date.now() + PARTY_ROUTE_MS],
    );
  }

  /** Create one arena under a lease so parallel function instances make only one. */
  private async createArena(): Promise<boolean> {
    const now = Date.now();
    const lock = await this.pool!.query(
      `UPDATE agencoil_arena_lock SET until = $1 WHERE id = 1 AND until < $2 RETURNING id`,
      [now + LOCK_MS, now],
    );
    if (!lock.rowCount) {
      // Someone else is creating: wait for their row to become healthy.
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const arenas = await this.liveArenas();
        if (arenas.some((a) => a.health.ok && a.createdAt > now - LOCK_MS)) return true;
      }
      return false;
    }
    try {
      const name = `snek-arena-${now.toString(36)}`;
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
      await this.pool!.query(
        `INSERT INTO agencoil_arena (name, domain, created_at, expires_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET domain = EXCLUDED.domain, expires_at = EXCLUDED.expires_at`,
        [name, domain, now, expiresAt],
      );
      return true;
    } catch (err) {
      console.error("[arena] create failed:", (err as Error)?.message ?? err);
      return false;
    } finally {
      await this.pool!.query(`UPDATE agencoil_arena_lock SET until = 0 WHERE id = 1`).catch(
        () => undefined,
      );
    }
  }

  /** Ask an old arena to send its players to the coordinator, then forget it. */
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
    await this.pool!.query(`DELETE FROM agencoil_arena WHERE name = $1`, [r.name]);
    this.health.delete(r.name);
  }
}

async function probe(domain: string): Promise<ArenaHealth> {
  try {
    const res = await fetch(`${domain}/api/ws`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, players: 0, at: Date.now() };
    const j = (await res.json()) as { ok?: boolean; players?: number; draining?: boolean };
    return { ok: Boolean(j.ok) && !j.draining, players: Number(j.players) || 0, at: Date.now() };
  } catch {
    return { ok: false, players: 0, at: Date.now() };
  }
}
