/**
 * Authoritative arena server. One World per process; every connected player
 * is a snake steered by the inputs it sends, bots are run here, and clients
 * only receive what is near their camera.
 *
 * Runs unchanged as a Vercel Function (see ../api/ws.ts) or a plain Node
 * process (see ../dev.ts). Nothing here depends on the host.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
  ARENA_RADIUS,
  BOUNTY_MIN_MASS,
  BOUNTY_RATE,
  COMEBACK_KEEP,
  COMEBACK_WINDOW_MS,
  DISCONNECT_GRACE_MS,
  NEAR_COMBO_WINDOW,
  SWARM_DURATION_S,
  SWARM_EVERY_S,
  packSkin,
  unpackSkin,
  FOOD_SYNC_HZ,
  SERVER_BOTS,
  MAX_CUSTOM_BANDS,
  MAX_NET_POINTS,
  SERVER_TICK_HZ,
  SNAPSHOT_HZ,
  START_MASS,
  lengthOf,
  radiusOf,
  type Snake,
} from "../../src/game/model";
import { CELL, HOT_CELL, World, hotKey } from "../../src/game/world";
import { cleanName } from "./names";
import {
  C2S,
  Reader,
  S2C,
  Writer,
  readBands,
  writeBands,
  writeFood,
  writeSnakeEntry,
} from "../../src/game/protocol";
import { DailyBoard } from "./daily";
import { ProfileStore, type Profile } from "./profiles";
import { UNLOCK_DEATH, UNLOCK_TRAIL, type LifeStats } from "../../src/game/challenges";

interface View {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

interface Client {
  ws: WebSocket;
  ip: string;
  msgWindow: number;
  msgCount: number;
  sid: string | null;
  name: string;
  skin: number;
  bands?: string[];
  view: View;
  known: Set<string>;
  sentFood: Set<number>;
  /** Sequence number of the last input applied, echoed in snapshots. */
  seq: number;
  /** Newer protocol: device key present, gets STATS2/PROFILE/NEAR/EVENT. */
  v2: boolean;
  key: string;
  party: string;
  trail: number;
  deathFx: number;
  profile: Profile | null;
  life: Life | null;
  combo: { n: number; last: number };
  comebackUsed: boolean;
  deathAt: number;
  deathMass: number;
  bountied: boolean;
  lastPing: number;
  alive: boolean;
}

/** What the current life has done so far, for challenges and the profile. */
interface Life {
  startAt: number;
  near: number;
  remains: number;
  boosted: boolean;
  noboostLength: number;
  bounty: number;
}

interface Token {
  sid: string;
  mass: number;
  x: number;
  y: number;
  angle: number;
  skin: number;
  name: string;
  kills: number;
  exp: number;
}

const VIEW_MARGIN = 220;
const MAX_NAME = 16;
const TOKEN_TTL_MS = 60_000;
const IDLE_STOP_MS = 30_000;

const MAX_CONNS_PER_IP = 4;
const CONNECTS_PER_MINUTE = 20;
const MAX_MSGS_PER_SECOND = 60;
const HEAT_DECAY_MS = 10 * 60_000;
const HOT_THRESHOLD = 3;

function sanitizeName(raw: string): string {
  const s = raw
    .replace(/[^\p{L}\p{N} _.\-']/gu, "")
    .trim()
    .slice(0, MAX_NAME);
  return cleanName(s) || "anon";
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

function sanitizeBands(bands: string[] | undefined): string[] | undefined {
  if (!bands) return undefined;
  const ok = bands.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, MAX_CUSTOM_BANDS);
  return ok.length ? ok : undefined;
}

export class GameServer {
  readonly world = new World(true);
  readonly instance = `${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}-${randomBytes(3).toString("hex")}`;
  private readonly secret = process.env.GAME_SECRET ?? randomBytes(32).toString("hex");
  private readonly clients = new Set<Client>();
  private readonly nids = new Map<string, number>();
  private readonly grace = new Map<string, NodeJS.Timeout>();
  private readonly daily = new DailyBoard();
  private readonly profiles = new ProfileStore();
  private readonly parties = new Map<string, Set<string>>();
  private bountyOf = new Map<string, number>();
  private event: { x: number; y: number; until: number } | null = null;
  private readonly connsByIp = new Map<string, number>();
  private readonly connectLog = new Map<string, number[]>();
  /** Death sites by coarse cell with timestamps, for spawn placement. */
  private readonly heat = new Map<number, number[]>();
  /** Token signatures already redeemed, so a token cannot be replayed. */
  private readonly usedTokens = new Map<string, number>();
  private nextNid = 1;
  private nextPlayer = 1;
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastActivity = Date.now();
  private startedAt = Date.now();
  private stepMs = 0;
  private wss: WebSocketServer | null = null;

  constructor() {
    this.world.host = true;
    this.world.resetLocalBots(SERVER_BOTS);
    for (const s of this.world.snakes) this.nidOf(s.id);
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, maxPayload: 4096 });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    server.on("request", (req, res) => {
      if (req.headers.upgrade) return;
      res.setHeader("content-type", "application/json");
      res.setHeader("access-control-allow-origin", "*");
      res.end(JSON.stringify(this.status()));
    });
  }

  status(): Record<string, unknown> {
    const snakes = this.world.snakes;
    return {
      ok: true,
      instance: this.instance,
      players: snakes.filter((s) => !s.isBot).length,
      bots: snakes.filter((s) => s.isBot).length,
      clients: this.clients.size,
      foods: this.world.foods.length,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      tick: this.tick,
      stepMs: Math.round(this.stepMs * 100) / 100,
      hot: this.hotSpots(12),
      daily: this.daily.top(3),
    };
  }

  /** The busiest death cells, as cell centres. */
  private hotSpots(n: number): { x: number; y: number; deaths: number }[] {
    const now = Date.now();
    const out: { x: number; y: number; deaths: number }[] = [];
    for (const [key, times] of this.heat) {
      const recent = times.filter((t) => now - t < HEAT_DECAY_MS);
      if (!recent.length) continue;
      const gx = Math.floor(key / 128) - 64;
      const gy = (key % 128) - 64;
      out.push({ x: (gx + 0.5) * HOT_CELL, y: (gy + 0.5) * HOT_CELL, deaths: recent.length });
    }
    return out.sort((a, b) => b.deaths - a.deaths).slice(0, n);
  }

  private recordDeath(x: number, y: number): void {
    const key = hotKey(x, y);
    const now = Date.now();
    const times = (this.heat.get(key) ?? []).filter((t) => now - t < HEAT_DECAY_MS);
    times.push(now);
    this.heat.set(key, times);
    if (times.length >= HOT_THRESHOLD) this.world.hot.add(key);
  }

  private decayHeat(): void {
    const now = Date.now();
    for (const [key, times] of this.heat) {
      const recent = times.filter((t) => now - t < HEAT_DECAY_MS);
      if (recent.length) this.heat.set(key, recent);
      else this.heat.delete(key);
      if (recent.length < HOT_THRESHOLD) this.world.hot.delete(key);
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private ensureLoop(): void {
    if (this.timer) return;
    let last = Date.now();
    let acc = 0;
    const dt = 1 / SERVER_TICK_HZ;
    this.timer = setInterval(() => {
      const now = Date.now();
      acc += Math.min(0.25, (now - last) / 1000);
      last = now;
      let steps = 0;
      while (acc >= dt && steps < 4) {
        this.step(dt);
        acc -= dt;
        steps++;
      }
      if (acc > dt * 2) acc = dt;
      if (this.clients.size === 0 && now - this.lastActivity > IDLE_STOP_MS) this.stopLoop();
    }, 1000 / SERVER_TICK_HZ);
  }

  private stopLoop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private nidOf(sid: string): number {
    let n = this.nids.get(sid);
    if (n === undefined) {
      const taken = new Set(this.nids.values());
      do {
        n = this.nextNid++;
        if (this.nextNid > 65000) this.nextNid = 1;
      } while (taken.has(n));
      this.nids.set(sid, n);
    }
    return n;
  }

  // ── connections ────────────────────────────────────────────────────────────

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (this.connectLog.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.connectLog.set(ip, recent);
    if (recent.length > CONNECTS_PER_MINUTE || (this.connsByIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
      ws.close(1008, "too many connections");
      return;
    }
    this.connsByIp.set(ip, (this.connsByIp.get(ip) ?? 0) + 1);
    const client: Client = {
      ws,
      ip,
      msgWindow: now,
      msgCount: 0,
      sid: null,
      name: "anon",
      skin: 0,
      view: { cx: 0, cy: 0, hw: 900, hh: 600 },
      known: new Set(),
      sentFood: new Set(),
      seq: 0,
      v2: false,
      key: "",
      party: "",
      trail: 0,
      deathFx: 0,
      profile: null,
      life: null,
      combo: { n: 0, last: 0 },
      comebackUsed: false,
      deathAt: 0,
      deathMass: 0,
      bountied: false,
      lastPing: Date.now(),
      alive: true,
    };
    this.clients.add(client);
    this.lastActivity = Date.now();
    this.ensureLoop();
    ws.binaryType = "arraybuffer";
    ws.on("message", (data) => this.onMessage(client, data));
    ws.on("close", () => this.onClose(client));
    ws.on("error", () => this.onClose(client));
    ws.send(
      new Writer().u8(S2C.WELCOME).str(this.instance).f32(ARENA_RADIUS).u8(SERVER_TICK_HZ).finish(),
    );
  }

  private onClose(client: Client): void {
    if (!client.alive) return;
    client.alive = false;
    this.clients.delete(client);
    const n = (this.connsByIp.get(client.ip) ?? 1) - 1;
    if (n <= 0) this.connsByIp.delete(client.ip);
    else this.connsByIp.set(client.ip, n);
    this.lastActivity = Date.now();
    const sid = client.sid;
    client.sid = null;
    if (client.party) this.parties.get(client.party)?.delete(sid ?? "");
    if (!sid) return;
    // Hold the snake for a moment so a reconnect (forced by the platform's
    // connection cap, or a flaky network) can pick it back up.
    const input = this.world.inputs.get(sid);
    if (input) input.boost = false;
    this.grace.set(
      sid,
      setTimeout(() => {
        this.grace.delete(sid);
        this.world.killSnake(sid);
      }, DISCONNECT_GRACE_MS),
    );
  }

  private onMessage(client: Client, data: RawData): void {
    if (!client.alive) return;
    const now = Date.now();
    if (now - client.msgWindow > 1000) {
      client.msgWindow = now;
      client.msgCount = 0;
    }
    if (++client.msgCount > MAX_MSGS_PER_SECOND) {
      client.ws.close(1008, "too fast");
      return;
    }
    let buf: Uint8Array;
    if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
    else if (Array.isArray(data)) buf = new Uint8Array(Buffer.concat(data));
    else buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!buf.byteLength) return;
    const r = new Reader(buf);
    try {
      const type = r.u8();
      if (type === C2S.HELLO || type === C2S.SPAWN)
        void this.onHello(client, r, type === C2S.SPAWN).catch((err) => {
          console.error("[hello] failed:", (err as Error)?.message ?? err);
        });
      else if (type === C2S.INPUT) this.onInput(client, r);
      else if (type === C2S.IDENT) void this.onIdent(client, r);
      else if (type === C2S.PING) client.ws.send(new Writer().u8(S2C.PONG).u32(r.u32()).finish());
    } catch {
      client.ws.close(1003, "bad message");
    }
  }

  private async onHello(client: Client, r: Reader, respawn: boolean): Promise<void> {
    client.name = sanitizeName(r.str());
    const look = unpackSkin(r.u8());
    client.skin = look.skin;
    client.bands = sanitizeBands(readBands(r));
    const tokenText = r.remaining ? r.str() : "";
    // v2 clients append: device key, death effect, party code, comeback flag.
    let comeback = false;
    if (r.remaining) {
      client.v2 = true;
      client.key = r
        .str()
        .replace(/[^A-Za-z0-9_-]/g, "")
        .slice(0, 64);
      client.deathFx = r.remaining ? r.u8() : 0;
      client.party = r.remaining
        ? r
            .str()
            .replace(/[^A-Za-z0-9]/g, "")
            .slice(0, 12)
        : "";
      comeback = r.remaining ? r.u8() === 1 : false;
      if (client.key && !client.profile)
        client.profile = await this.profiles.load(client.key, client.name);
      if (!client.alive) return;
      const unlocks = client.profile?.unlocks ?? 0;
      client.trail =
        look.trail < UNLOCK_TRAIL.length &&
        (look.trail === 0 || unlocks & UNLOCK_TRAIL[look.trail]!)
          ? look.trail
          : 0;
      client.deathFx =
        client.deathFx < UNLOCK_DEATH.length &&
        (client.deathFx === 0 || unlocks & UNLOCK_DEATH[client.deathFx]!)
          ? client.deathFx
          : 0;
    }
    if (client.sid && this.world.snakes.some((s) => s.id === client.sid && s.alive)) {
      // Already playing: a repeated hello just updates the look next spawn,
      // and a respawn request ends the current life first so no snake is
      // left running unowned.
      if (!respawn) return;
      this.world.killSnake(client.sid);
      client.sid = null;
    }
    const token = tokenText && !respawn ? this.redeemToken(tokenText) : null;
    let snake: Snake | null = null;
    if (token) {
      const held = this.world.snakes.find((s) => s.id === token.sid && s.alive);
      const timer = this.grace.get(token.sid);
      const owner = held ? [...this.clients].find((c) => c !== client && c.sid === held.id) : null;
      if (held && (timer || owner)) {
        // Reattach. If another socket still owns the snake (the old
        // connection has not closed yet), ownership moves here rather than a
        // second copy being built.
        if (timer) clearTimeout(timer);
        this.grace.delete(token.sid);
        if (owner) {
          owner.sid = null;
          owner.known.clear();
        }
        snake = held;
        snake.name = client.name;
        snake.skin = client.skin;
        snake.bands = client.bands;
      } else {
        // The snake lived on another instance (or was lost): rebuild it with
        // the same length near where it was.
        const at = this.world.safeSpawnNear({ x: token.x, y: token.y });
        snake = this.world.spawnSnake(
          this.newSid(),
          client.name,
          client.skin,
          false,
          client.bands,
          token.mass,
        );
        snake.x = at.x;
        snake.y = at.y;
        snake.points = [];
        this.world.ensureTrail(snake);
        snake.kills = token.kills;
      }
    } else {
      // A comeback keeps a quarter of the lost length, once per connection,
      // if asked for within a few seconds of dying.
      const now = Date.now();
      let mass: number | undefined;
      if (
        respawn &&
        comeback &&
        !client.comebackUsed &&
        client.deathAt &&
        now - client.deathAt < COMEBACK_WINDOW_MS
      ) {
        mass = Math.max(START_MASS + 1, Math.floor(client.deathMass * COMEBACK_KEEP));
        client.comebackUsed = true;
      }
      snake = this.world.spawnSnake(
        this.newSid(),
        client.name,
        client.skin,
        false,
        client.bands,
        mass,
      );
      // Friends spawn together: near any live member of the same party.
      const mate = client.party ? this.partyMember(client.party, snake.id) : null;
      if (mate) {
        const at = this.world.safeSpawnNear({ x: mate.x, y: mate.y });
        snake.x = at.x;
        snake.y = at.y;
        snake.angle = mate.angle;
        snake.points = [];
        this.world.ensureTrail(snake);
      }
    }
    snake.trail = client.trail;
    snake.deathFx = client.deathFx;
    client.sid = snake.id;
    client.known.clear();
    client.life = {
      startAt: Date.now(),
      near: 0,
      remains: 0,
      boosted: false,
      noboostLength: snake.mass,
      bounty: 0,
    };
    client.combo = { n: 0, last: 0 };
    client.bountied = false;
    if (client.party) {
      let set = this.parties.get(client.party);
      if (!set) this.parties.set(client.party, (set = new Set()));
      set.add(snake.id);
    }
    this.world.inputs.set(snake.id, { angle: snake.angle, boost: false });
    this.world.nearIds.add(snake.id);
    const nid = this.nidOf(snake.id);
    client.ws.send(
      new Writer()
        .u8(S2C.SPAWNED)
        .u16(nid)
        .f32(snake.x)
        .f32(snake.y)
        .angle(snake.angle)
        .f32(snake.mass)
        .finish(),
    );
    this.sendToken(client);
    if (client.v2) {
      void this.sendProfile(client);
      if (this.event && this.event.until > Date.now()) this.sendEvent(client);
    }
  }

  /** A v2 client introducing itself before playing: load and send its profile. */
  private async onIdent(client: Client, r: Reader): Promise<void> {
    const key = r
      .str()
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 64);
    const name = sanitizeName(r.remaining ? r.str() : "anon");
    if (!key) return;
    client.v2 = true;
    client.key = key;
    if (!client.profile) client.profile = await this.profiles.load(key, name);
    if (!client.alive) return;
    void this.sendProfile(client);
    if (this.event && this.event.until > Date.now()) this.sendEvent(client);
  }

  private partyMember(code: string, exceptSid: string): Snake | null {
    const set = this.parties.get(code);
    if (!set) return null;
    for (const sid of set) {
      if (sid === exceptSid) continue;
      const s = this.world.snakes.find((x) => x.id === sid && x.alive);
      if (s) return s;
    }
    return null;
  }

  private async sendProfile(client: Client): Promise<void> {
    const p = client.profile;
    if (!p || !client.alive) return;
    const rank = await this.profiles.rank(p);
    if (!client.alive) return;
    client.ws.send(
      new Writer()
        .u8(S2C.PROFILE)
        .u32(p.best)
        .u32(p.kills)
        .u32(p.games)
        .u32(p.survive)
        .u32(rank)
        .u32(p.unlocks)
        .u8(this.profiles.persistent ? 1 : 0)
        .finish(),
    );
    const list = this.profiles.challenges(p);
    const w = new Writer().u8(S2C.CHALLENGES).u8(list.length);
    for (const c of list)
      w.u8(c.challenge.id)
        .str(c.challenge.text)
        .u32(c.challenge.target)
        .u32(c.progress)
        .u8(c.done ? 1 : 0);
    client.ws.send(w.finish());
  }

  private notice(client: Client, kind: number, text: string): void {
    if (!client.v2 || !client.alive) return;
    client.ws.send(new Writer().u8(S2C.NOTICE).u8(kind).str(text).finish());
  }

  private sendEvent(client: Client): void {
    if (!this.event || !client.v2) return;
    const left = Math.max(0, Math.round((this.event.until - Date.now()) / 1000));
    client.ws.send(
      new Writer().u8(S2C.EVENT).f32(this.event.x).f32(this.event.y).u16(left).finish(),
    );
  }

  private newSid(): string {
    return `p${this.nextPlayer++}`;
  }

  private onInput(client: Client, r: Reader): void {
    // New clients prefix a sequence number; older ones (still deployed on
    // the platform frontend) do not. Tell them apart by length.
    if (r.remaining >= 21) client.seq = r.u16();
    const angle = r.angle();
    const boost = r.u8() === 1;
    client.view = {
      cx: r.f32(),
      cy: r.f32(),
      hw: Math.min(4000, r.f32()),
      hh: Math.min(3000, r.f32()),
    };
    if (!client.sid) return;
    const input = this.world.inputs.get(client.sid);
    if (input) {
      input.angle = angle;
      input.boost = boost;
    }
  }

  // ── tokens ─────────────────────────────────────────────────────────────────

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private makeToken(s: Snake): string {
    const t: Token = {
      sid: s.id,
      mass: Math.round(s.mass * 10) / 10,
      x: Math.round(s.x),
      y: Math.round(s.y),
      angle: Math.round(s.angle * 1000) / 1000,
      skin: s.skin,
      name: s.name,
      kills: s.kills,
      exp: Date.now() + TOKEN_TTL_MS,
    };
    const payload = Buffer.from(JSON.stringify(t)).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /** Verify a token and mark it spent; a replayed token is refused. */
  private redeemToken(text: string): Token | null {
    const t = this.verifyToken(text);
    if (!t) return null;
    const sig = text.slice(text.indexOf(".") + 1);
    const now = Date.now();
    for (const [k, exp] of this.usedTokens) if (exp < now) this.usedTokens.delete(k);
    if (this.usedTokens.has(sig)) return null;
    this.usedTokens.set(sig, t.exp);
    return t;
  }

  private verifyToken(text: string): Token | null {
    const dot = text.indexOf(".");
    if (dot < 0) return null;
    const payload = text.slice(0, dot);
    const sigBuf = Buffer.from(text.slice(dot + 1));
    const expectBuf = Buffer.from(this.sign(payload));
    if (sigBuf.length !== expectBuf.length || !timingSafeEqual(sigBuf, expectBuf)) return null;
    try {
      const t = JSON.parse(Buffer.from(payload, "base64url").toString()) as Token;
      if (typeof t.mass !== "number" || t.exp < Date.now()) return null;
      t.mass = Math.min(t.mass, 100_000);
      return t;
    } catch {
      return null;
    }
  }

  private sendToken(client: Client): void {
    if (!client.sid) return;
    const s = this.world.snakes.find((x) => x.id === client.sid && x.alive);
    if (!s) return;
    client.ws.send(new Writer().u8(S2C.TOKEN).str(this.makeToken(s)).finish());
  }

  // ── simulation and broadcast ───────────────────────────────────────────────

  private step(dt: number): void {
    const t0 = performance.now();
    this.tick++;
    this.world.step(dt, 0, 0, false);
    this.stepMs = this.stepMs * 0.95 + (performance.now() - t0) * 0.05;
    for (const s of this.world.snakes) if (!this.nids.has(s.id)) this.nidOf(s.id);

    if (this.world.deaths.length) this.onDeaths();
    if (this.world.eats.length) this.onEats();
    if (this.world.nears.length) this.onNears();
    this.trackLives();
    if (this.tick % (SERVER_TICK_HZ * SWARM_EVERY_S) === 0 && this.clients.size) this.startSwarm();

    const snapEvery = Math.max(1, Math.round(SERVER_TICK_HZ / SNAPSHOT_HZ));
    const foodEvery = Math.max(1, Math.round(SERVER_TICK_HZ / FOOD_SYNC_HZ));
    if (this.tick % snapEvery === 0) for (const c of this.clients) this.sendSnapshot(c);
    if (this.tick % foodEvery === 0) for (const c of this.clients) this.sendFood(c);
    if (this.tick % Math.round(SERVER_TICK_HZ / 2) === 0) this.sendStatsAll();
    if (this.tick % SERVER_TICK_HZ === 0) for (const c of this.clients) this.sendToken(c);
    if (this.tick % (SERVER_TICK_HZ * 30) === 0) this.decayHeat();
  }

  private trackLives(): void {
    for (const c of this.clients) {
      if (!c.sid || !c.life) continue;
      const s = this.world.snakes.find((x) => x.id === c.sid);
      if (!s) continue;
      if (s.boosting) c.life.boosted = true;
      if (!c.life.boosted && s.mass > c.life.noboostLength) c.life.noboostLength = s.mass;
    }
  }

  private onNears(): void {
    const now = Date.now();
    for (const n of this.world.nears) {
      const c = [...this.clients].find((x) => x.sid === n.id);
      if (!c || !c.life) continue;
      c.combo = { n: now - c.combo.last < NEAR_COMBO_WINDOW * 1000 ? c.combo.n + 1 : 1, last: now };
      c.life.near++;
      const s = this.world.snakes.find((x) => x.id === n.id);
      const bonus = 1 + Math.min(c.combo.n, 6) * 0.5;
      if (s) s.mass += bonus;
      if (c.v2)
        c.ws.send(
          new Writer()
            .u8(S2C.NEAR)
            .u8(Math.min(255, c.combo.n))
            .u16(Math.round(bonus * 10))
            .finish(),
        );
    }
  }

  private startSwarm(): void {
    const at = this.world.randomOpenPoint();
    this.world.spawnGoldSwarm(at.x, at.y);
    this.event = { x: at.x, y: at.y, until: Date.now() + SWARM_DURATION_S * 1000 };
    for (const c of this.clients) this.sendEvent(c);
  }

  /** Refresh which snakes carry a bounty; tell newly marked players. */
  private refreshBounties(alive: Snake[]): void {
    const next = new Map<string, number>();
    for (const s of alive.slice(0, 3)) {
      if (s.mass >= BOUNTY_MIN_MASS) next.set(s.id, Math.floor(s.mass * BOUNTY_RATE));
    }
    this.bountyOf = next;
    for (const c of this.clients) {
      if (!c.sid) continue;
      const has = next.has(c.sid);
      if (has && !c.bountied) this.notice(c, 1, `a bounty of ${next.get(c.sid)} is on your head`);
      c.bountied = has;
    }
  }

  private onDeaths(): void {
    for (const d of this.world.deaths) {
      const s = d.snake;
      const nid = this.nidOf(s.id);
      const killerNid = d.killerId ? this.nidOf(d.killerId) : 0;
      const msg = new Writer()
        .u8(S2C.DEATH)
        .u16(nid)
        .u16(killerNid)
        .u8(d.reason === "wall" ? 0 : 1)
        .str(d.killerName ?? "")
        .str(s.name)
        .u32(Math.floor(s.mass))
        .u16(s.kills)
        .finish();
      const bounty = this.bountyOf.get(s.id) ?? 0;
      const killerClient = d.killerId ? [...this.clients].find((c) => c.sid === d.killerId) : null;
      for (const c of this.clients) {
        if (c.known.has(s.id) || c.sid === s.id || (d.killerId && c.sid === d.killerId))
          c.ws.send(msg);
        c.known.delete(s.id);
        if (c.sid === s.id) this.endLife(c, s);
      }
      if (bounty && d.killerId) {
        const killer = this.world.snakes.find((x) => x.id === d.killerId && x.alive);
        if (killer) killer.mass += Math.min(600, Math.floor(bounty * 0.3));
        if (killerClient?.life) killerClient.life.bounty++;
        const line = `${d.killerName ?? "someone"} claimed the ${bounty} bounty on ${s.name}`;
        for (const c of this.clients) this.notice(c, 1, line);
      }
      if (!s.isBot) this.daily.record(s.name, Math.floor(s.mass));
      this.nids.delete(s.id);
      if (d.reason === "snake") this.recordDeath(s.x, s.y);
      this.world.inputs.delete(s.id);
      const g = this.grace.get(s.id);
      if (g) {
        clearTimeout(g);
        this.grace.delete(s.id);
      }
    }
  }

  /** Close out a player's life: profile, challenges, comeback window. */
  private endLife(c: Client, s: Snake): void {
    c.sid = null;
    this.world.nearIds.delete(s.id);
    if (c.party) this.parties.get(c.party)?.delete(s.id);
    c.deathAt = Date.now();
    c.deathMass = s.mass;
    const life = c.life;
    c.life = null;
    if (!life) return;
    if (c.v2 && !c.comebackUsed) this.notice(c, 3, "comeback");
    if (!c.profile) return;
    const stats: LifeStats = {
      length: Math.floor(s.mass),
      kills: s.kills,
      survive: (Date.now() - life.startAt) / 1000,
      near: life.near,
      remains: Math.floor(life.remains),
      noboostLength: Math.floor(life.noboostLength),
      bounty: life.bounty,
    };
    const completed = this.profiles.recordLife(c.profile, stats);
    for (const ch of completed) this.notice(c, 2, `challenge complete: ${ch.text}`);
    void this.sendProfile(c);
  }

  private onEats(): void {
    const bySid = new Map<string, Writer>();
    const counts = new Map<string, number>();
    for (const e of this.world.eats) {
      if (e.k === 2) {
        const c = [...this.clients].find((x) => x.sid === e.id);
        if (c?.life) c.life.remains += e.v;
      }
      let w = bySid.get(e.id);
      if (!w) {
        w = new Writer().u8(S2C.EAT).u16(0);
        bySid.set(e.id, w);
        counts.set(e.id, 0);
      }
      const n = counts.get(e.id)!;
      if (n >= 48) continue;
      w.f32(e.x)
        .f32(e.y)
        .u16(Math.round(e.v * 10))
        .u8(e.c);
      counts.set(e.id, n + 1);
    }
    for (const c of this.clients) {
      if (!c.sid) continue;
      const w = bySid.get(c.sid);
      if (!w) continue;
      const bytes = w.finish();
      new DataView(bytes.buffer, bytes.byteOffset).setUint16(1, counts.get(c.sid)!);
      c.ws.send(bytes);
    }
  }

  private inView(v: View, x: number, y: number, pad: number): boolean {
    return Math.abs(x - v.cx) <= v.hw + pad && Math.abs(y - v.cy) <= v.hh + pad;
  }

  private snakeVisible(c: Client, s: Snake): boolean {
    if (s.id === c.sid) return true;
    const r = radiusOf(s.mass);
    if (this.inView(c.view, s.x, s.y, VIEW_MARGIN + r)) return true;
    // A long body can be on screen while the head is far away.
    if (!this.inView(c.view, s.x, s.y, VIEW_MARGIN + lengthOf(s.mass) + r)) return false;
    const pts = s.points;
    const stride = Math.max(1, (pts.length / 12) | 0);
    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i]!;
      if (this.inView(c.view, p.x, p.y, VIEW_MARGIN + r)) return true;
    }
    return false;
  }

  private sendSnapshot(c: Client): void {
    if (c.seq) c.ws.send(new Writer().u8(S2C.ACK).u16(c.seq).finish());
    const w = new Writer()
      .u8(S2C.SNAP)
      .u32(this.tick)
      .u32(Date.now() >>> 0);
    const visible: Snake[] = [];
    for (const s of this.world.snakes) if (s.alive && this.snakeVisible(c, s)) visible.push(s);
    w.u16(visible.length);
    const seen = new Set<string>();
    for (const s of visible) {
      const full = !c.known.has(s.id);
      const packed = s.trail ? { ...s, skin: packSkin(s.skin, s.trail) } : s;
      writeSnakeEntry(w, this.nidOf(s.id), packed, full, MAX_NET_POINTS);
      c.known.add(s.id);
      seen.add(s.id);
    }
    const gone: number[] = [];
    for (const sid of c.known) {
      if (!seen.has(sid)) {
        gone.push(this.nidOf(sid));
        c.known.delete(sid);
      }
    }
    w.u16(gone.length);
    for (const nid of gone) w.u16(nid);
    const chase = this.world.chaseOrbs;
    w.u8(chase.length);
    for (const f of chase)
      w.u32(f.id ?? 0)
        .f32(f.x)
        .f32(f.y);
    c.ws.send(w.finish());
  }

  private sendFood(c: Client): void {
    const v = c.view;
    const pad = VIEW_MARGIN + CELL;
    const x0 = v.cx - v.hw - pad;
    const y0 = v.cy - v.hh - pad;
    const x1 = v.cx + v.hw + pad;
    const y1 = v.cy + v.hh + pad;
    const add = new Writer().u8(S2C.FOOD_ADD).u16(0);
    let nAdd = 0;
    const seen = new Set<number>();
    this.world.forEachFoodIn(x0, y0, x1, y1, (f) => {
      const id = f.id!;
      seen.add(id);
      if (c.sentFood.has(id) || nAdd >= 1500) return;
      writeFood(add, f);
      c.sentFood.add(id);
      nAdd++;
    });
    const del = new Writer().u8(S2C.FOOD_DEL).u16(0);
    let nDel = 0;
    for (const id of c.sentFood) {
      if (seen.has(id)) continue;
      c.sentFood.delete(id);
      if (nDel >= 4000) continue;
      del.u32(id);
      nDel++;
    }
    if (nAdd) {
      const bytes = add.finish();
      new DataView(bytes.buffer, bytes.byteOffset).setUint16(1, nAdd);
      c.ws.send(bytes);
    }
    if (nDel) {
      const bytes = del.finish();
      new DataView(bytes.buffer, bytes.byteOffset).setUint16(1, nDel);
      c.ws.send(bytes);
    }
  }

  /** The ranking and boards are computed once, then each client gets its own line. */
  private sendStatsAll(): void {
    if (!this.clients.size) return;
    const alive = this.world.snakes.filter((s) => s.alive).sort((a, b) => b.mass - a.mass);
    this.refreshBounties(alive);
    const rankOf = new Map<string, number>();
    alive.forEach((s, i) => rankOf.set(s.id, i + 1));
    const top = alive.slice(0, 10);
    const daily = this.daily.top(10);
    const encodeBoard = (v2: boolean) => {
      const board = new Writer();
      board.u8(top.length);
      for (const s of top) {
        board.u16(this.nidOf(s.id)).str(s.name).u32(Math.floor(s.mass)).f32(s.x).f32(s.y);
        if (v2) board.u32(this.bountyOf.get(s.id) ?? 0);
      }
      board.u8(daily.length);
      for (const e of daily) board.str(e.name).u32(e.best);
      return board.finish();
    };
    const tail1 = encodeBoard(false);
    const tail2 = encodeBoard(true);
    for (const c of this.clients) {
      const me = c.sid ? alive.find((s) => s.id === c.sid) : undefined;
      const tail = c.v2 ? tail2 : tail1;
      const w = new Writer()
        .u8(c.v2 ? S2C.STATS2 : S2C.STATS)
        .f32(me?.mass ?? 0)
        .u16(me ? (rankOf.get(me.id) ?? 0) : 0)
        .u16(alive.length)
        .u16(me?.kills ?? 0)
        .u16(this.clients.size);
      w.raw(tail);
      c.ws.send(w.finish());
    }
  }
}

export function makeHelloPayload(
  name: string,
  skin: number,
  bands: string[] | undefined,
  token: string,
): Uint8Array {
  const w = new Writer().u8(C2S.HELLO).str(name).u8(skin);
  writeBands(w, bands);
  w.str(token);
  return w.finish();
}

export { START_MASS };
