/**
 * Client side of the arena protocol. Owns a mirror `World` that the renderer
 * draws from: other snakes are interpolated a little behind the server,
 * your own snake is predicted from your inputs and nudged toward what the
 * server says, and orbs arrive as add/remove deltas for the area on screen.
 */
import {
  BOOST_MIN_MASS,
  dist2,
  radiusOf,
  speedOf,
  type Food,
  type Snake,
  type Vec,
  lerp,
  wrapAngle,
} from "./model";
import { C2S, Reader, S2C, Writer, readFood, readSnakeEntry, writeBands } from "./protocol";
import { World } from "./world";

export type NetState = "connecting" | "online" | "offline";

export interface DeathInfo {
  nid: number;
  killerNid: number;
  reason: "wall" | "snake";
  killerName: string;
  name: string;
  finalLen: number;
  kills: number;
}

export interface StatsInfo {
  mass: number;
  rank: number;
  count: number;
  kills: number;
  clients: number;
  board: { nid: number; name: string; mass: number; x: number; y: number }[];
  daily: { name: string; best: number }[];
}

export interface EatInfo {
  x: number;
  y: number;
  v: number;
  c: number;
}

export interface NetHooks {
  onState: (state: NetState) => void;
  onSpawned: (snake: Snake) => void;
  onDeath: (d: DeathInfo) => void;
  onEats: (eats: EatInfo[]) => void;
  onStats: (s: StatsInfo) => void;
}

interface Snap {
  t: number;
  x: number;
  y: number;
  angle: number;
  mass: number;
  boosting: boolean;
  invuln: boolean;
}

interface Look {
  name: string;
  skin: number;
  bands?: string[];
}

const INPUT_HZ = 30;
/** A predicted eat the server has not confirmed by then is put back. */
const EAT_CONFIRM_MS = 700;
const OFFLINE_AFTER_MS = 6000;
const SNAP_CORRECT_DIST = 140;
/** Interpolation delay bounds; the live value tracks observed snapshot jitter. */
const INTERP_MIN_MS = 110;
const INTERP_MAX_MS = 260;
const JITTER_WINDOW_MS = 6000;
const TOKEN_KEY = "agencoil-resume";

export function defaultServerUrl(): string {
  const env = (import.meta.env.VITE_GAME_SERVER as string | undefined)?.trim();
  if (env) return env;
  return "wss://agencoil-server.vercel.app/api/ws";
}

export class NetSession {
  readonly world = new World(false);
  state: NetState = "connecting";
  selfNid = 0;
  instance = "";
  rttMs = 0;
  private ws: WebSocket | null = null;
  private token = "";
  private look: Look | null = null;
  private wantPlay = false;
  private closed = false;
  private attempts = 0;
  private firstTry = performance.now();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private buffers = new Map<string, Snap[]>();
  private serverSelf: {
    t: number;
    x: number;
    y: number;
    angle: number;
    mass: number;
    boosting: boolean;
    ack: number;
  } | null = null;
  /** Correction still to be applied to the predicted head, applied smoothly. */
  private offset = { x: 0, y: 0 };
  /** Predicted head at the moment each input was sent, keyed by sequence. */
  private history: { seq: number; x: number; y: number; angle: number }[] = [];
  private seq = 0;
  private lastAck = 0;
  /** Recent snapshot gaps, to size the interpolation delay. */
  private gaps: { t: number; gap: number }[] = [];
  private interpDelay = INTERP_MIN_MS;
  private lastInput = 0;
  private pingSent = 0;
  /** Set on spawn: the next full entry for us carries the real body shape. */
  private awaitingBody = false;
  /** Orbs removed locally the moment the head reaches them, awaiting FOOD_DEL. */
  private pendingEats = new Map<number, { food: Food; t: number }>();
  /** Predicted eats the server never confirmed (diagnostic). */
  eatMisses = 0;
  /** Diagnostics for the netcode: snapshot timing and prediction error. */
  diag = {
    snaps: 0,
    gapMax: 0,
    gapSum: 0,
    snaps200: 0,
    corrSum: 0,
    corrMax: 0,
    snapsHard: 0,
  };
  private lastSnapAt = 0;

  constructor(
    private readonly url: string,
    private readonly hooks: NetHooks,
  ) {
    try {
      this.token = sessionStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
      /* ignore */
    }
  }

  get selfId(): string {
    return String(this.selfNid);
  }

  get playing(): boolean {
    return this.selfNid > 0 && this.world.snakes.some((s) => s.id === this.selfId);
  }

  connect(): void {
    if (this.closed) return;
    this.setState(this.state === "online" ? "connecting" : this.state);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.setState("online");
      if (this.wantPlay && this.look) this.sendHello(false);
      this.pingTimer = setInterval(() => this.ping(), 2000);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) this.onMessage(new Reader(ev.data));
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === ws) this.ws = null;
      // An established session that drops gets a fresh grace window before
      // it counts as offline.
      if (this.state === "online") this.firstTry = performance.now();
      this.scheduleRetry();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    this.attempts++;
    const waited = performance.now() - this.firstTry;
    if (this.state !== "online" && waited > OFFLINE_AFTER_MS) this.setState("offline");
    else if (this.state === "online") this.setState("connecting");
    const delay = Math.min(5000, 400 * Math.pow(1.7, Math.min(6, this.attempts)));
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private setState(s: NetState): void {
    if (this.state === s) return;
    this.state = s;
    this.hooks.onState(s);
  }

  // ── outgoing ───────────────────────────────────────────────────────────────

  /** Join the arena (or respawn after death) with this look. */
  play(look: Look): void {
    this.look = look;
    this.wantPlay = true;
    if (this.ws?.readyState === WebSocket.OPEN) this.sendHello(this.selfNid > 0 && !this.playing);
  }

  /** Stop auto-respawning after a reconnect (menu, or death screen). */
  idle(): void {
    this.wantPlay = false;
  }

  private sendHello(respawn: boolean): void {
    if (!this.look || !this.ws) return;
    const w = new Writer()
      .u8(respawn ? C2S.SPAWN : C2S.HELLO)
      .str(this.look.name)
      .u8(this.look.skin);
    writeBands(w, this.look.bands);
    w.str(respawn ? "" : this.token);
    this.ws.send(w.finish());
  }

  sendInput(
    angle: number,
    boost: boolean,
    view: { cx: number; cy: number; hw: number; hh: number },
  ): void {
    const now = performance.now();
    if (now - this.lastInput < 1000 / INPUT_HZ) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.lastInput = now;
    this.seq = (this.seq % 65535) + 1;
    const me = this.world.player;
    if (me) {
      this.history.push({ seq: this.seq, x: me.x, y: me.y, angle: me.angle });
      if (this.history.length > 90) this.history.shift();
    }
    this.ws.send(
      new Writer()
        .u8(C2S.INPUT)
        .u16(this.seq)
        .angle(angle)
        .u8(boost ? 1 : 0)
        .f32(view.cx)
        .f32(view.cy)
        .f32(view.hw)
        .f32(view.hh)
        .finish(),
    );
  }

  private ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.pingSent = performance.now();
    this.ws.send(
      new Writer()
        .u8(C2S.PING)
        .u32(Math.round(this.pingSent) >>> 0)
        .finish(),
    );
  }

  // ── incoming ───────────────────────────────────────────────────────────────

  private onMessage(r: Reader): void {
    const type = r.u8();
    switch (type) {
      case S2C.WELCOME: {
        const instance = r.str();
        if (this.instance && this.instance !== instance) {
          // Different server process: nothing we know is valid any more.
          this.world.snakes = [];
          this.world.clearFood();
          this.buffers.clear();
        }
        this.instance = instance;
        break;
      }
      case S2C.SPAWNED: {
        const nid = r.u16();
        const x = r.f32();
        const y = r.f32();
        const angle = r.angle();
        const mass = r.f32();
        this.selfNid = nid;
        this.pendingEats.clear();
        this.history = [];
        this.offset = { x: 0, y: 0 };
        const id = String(nid);
        this.world.snakes = this.world.snakes.filter((s) => s.id !== id);
        const s = this.world.makeSnake(id, this.look?.name ?? "anon", this.look?.skin ?? 0, false);
        s.x = x;
        s.y = y;
        s.angle = angle;
        s.mass = mass;
        s.bands = this.look?.bands;
        s.points = [];
        this.world.ensureTrail(s);
        this.world.snakes.push(s);
        this.world.playerId = id;
        this.serverSelf = null;
        this.awaitingBody = true;
        this.hooks.onSpawned(s);
        break;
      }
      case S2C.SNAP:
        this.onSnap(r);
        break;
      case S2C.FOOD_ADD: {
        const n = r.u16();
        for (let i = 0; i < n; i++) {
          const f = readFood(r);
          if (f.id !== undefined && (this.world.foodById.has(f.id) || this.pendingEats.has(f.id)))
            continue;
          this.world.addFood(f);
        }
        break;
      }
      case S2C.FOOD_DEL: {
        const n = r.u16();
        for (let i = 0; i < n; i++) {
          const id = r.u32();
          this.pendingEats.delete(id);
          this.world.removeFoodById(id);
        }
        break;
      }
      case S2C.STATS: {
        const s: StatsInfo = {
          mass: r.f32(),
          rank: r.u16(),
          count: r.u16(),
          kills: r.u16(),
          clients: r.u16(),
          board: [],
          daily: [],
        };
        const nb = r.u8();
        for (let i = 0; i < nb; i++)
          s.board.push({ nid: r.u16(), name: r.str(), mass: r.u32(), x: r.f32(), y: r.f32() });
        const nd = r.u8();
        for (let i = 0; i < nd; i++) s.daily.push({ name: r.str(), best: r.u32() });
        this.hooks.onStats(s);
        break;
      }
      case S2C.EAT: {
        // Eats are predicted locally with their own effects; the server's
        // list only matters for orbs the prediction missed (none in view).
        const n = r.u16();
        for (let i = 0; i < n; i++) {
          r.f32();
          r.f32();
          r.u16();
          r.u8();
        }
        break;
      }
      case S2C.DEATH: {
        const d: DeathInfo = {
          nid: r.u16(),
          killerNid: r.u16(),
          reason: r.u8() === 0 ? "wall" : "snake",
          killerName: r.str(),
          name: r.str(),
          finalLen: r.u32(),
          kills: r.u16(),
        };
        const id = String(d.nid);
        if (d.nid === this.selfNid) {
          this.serverSelf = null;
          this.token = "";
          try {
            sessionStorage.removeItem(TOKEN_KEY);
          } catch {
            /* ignore */
          }
        }
        this.hooks.onDeath(d);
        this.world.removeSnake(id, false);
        this.buffers.delete(id);
        if (d.nid === this.selfNid) this.world.playerId = null;
        break;
      }
      case S2C.TOKEN:
        this.token = r.str();
        try {
          sessionStorage.setItem(TOKEN_KEY, this.token);
        } catch {
          /* ignore */
        }
        break;
      case S2C.ACK:
        this.lastAck = r.u16();
        break;
      case S2C.PONG: {
        r.u32();
        this.rttMs = Math.round(performance.now() - this.pingSent);
        break;
      }
      default:
        break;
    }
  }

  private onSnap(r: Reader): void {
    r.u32(); // tick
    r.u32(); // server time (unused; receipt time drives interpolation)
    const ack = this.lastAck;
    const now = performance.now();
    if (this.lastSnapAt) {
      const gap = now - this.lastSnapAt;
      this.diag.snaps++;
      this.diag.gapSum += gap;
      if (gap > this.diag.gapMax) this.diag.gapMax = gap;
      if (gap > 200) this.diag.snaps200++;
      // Size the interpolation delay from the worst gap seen recently, so
      // other snakes never run past their newest sample and jerk back.
      this.gaps.push({ t: now, gap });
      while (this.gaps.length && now - this.gaps[0]!.t > JITTER_WINDOW_MS) this.gaps.shift();
      let worst = 0;
      for (const g of this.gaps) if (g.gap > worst) worst = g.gap;
      this.interpDelay = Math.min(INTERP_MAX_MS, Math.max(INTERP_MIN_MS, worst * 1.4));
    }
    this.lastSnapAt = now;
    const n = r.u16();
    for (let i = 0; i < n; i++) {
      const e = readSnakeEntry(r);
      const id = String(e.nid);
      if (e.nid === this.selfNid) {
        this.serverSelf = {
          t: now,
          x: e.x,
          y: e.y,
          angle: e.angle,
          mass: e.mass,
          boosting: e.boosting,
          ack,
        };
        this.reconcile(ack, e.x, e.y, e.angle);
        const me = this.world.snakes.find((s) => s.id === id);
        if (me && e.full && e.points && e.points.length > 1 && this.awaitingBody) {
          // A reattached snake gets its real body back instead of the
          // straight placeholder laid on spawn.
          me.points = e.points;
          this.awaitingBody = false;
          this.world.trimBody(me);
        }
        continue;
      }
      let s = this.world.snakes.find((x) => x.id === id);
      if (e.full || !s) {
        if (!e.full) continue; // never seen it whole; the next snapshot will be full
        s = {
          id,
          name: e.name ?? "",
          skin: e.skin ?? 0,
          bands: e.bands,
          x: e.x,
          y: e.y,
          angle: e.angle,
          mass: e.mass,
          boosting: e.boosting,
          points: e.points ?? [],
          alive: true,
          isBot: e.isBot,
          invuln: e.invuln ? 1 : 0,
          wander: e.angle,
          think: 0,
          avoid: 0,
          avoidDir: 1,
          boostLeft: 0,
          dropped: 0,
          temper: 0.5,
          kills: 0,
        };
        if (!s.points.length) this.world.ensureTrail(s);
        this.world.upsertRemote(s);
        this.buffers.set(id, []);
      }
      const buf = this.buffers.get(id) ?? [];
      buf.push({
        t: now,
        x: e.x,
        y: e.y,
        angle: e.angle,
        mass: e.mass,
        boosting: e.boosting,
        invuln: e.invuln,
      });
      while (buf.length > 10) buf.shift();
      this.buffers.set(id, buf);
    }
    const gone = r.u16();
    for (let i = 0; i < gone; i++) {
      const nid = r.u16();
      if (nid === this.selfNid) continue;
      const id = String(nid);
      this.world.removeSnake(id, false);
      this.buffers.delete(id);
    }
    const chase = r.u8();
    for (let i = 0; i < chase; i++) {
      const id = r.u32();
      const x = r.f32();
      const y = r.f32();
      const f = this.world.foodById.get(id);
      if (f) this.world.moveFood(f, x, y);
    }
  }

  /**
   * Compare the server's head with what we had predicted at the input it
   * acknowledges. The difference is true prediction error, free of latency,
   * and is folded into `offset` for the frame loop to apply gradually. A
   * large error (teleport, hop, rebuilt snake) is applied at once.
   */
  private reconcile(ack: number, sx: number, sy: number, sangle: number): void {
    const me = this.world.player;
    if (!me) return;
    let hist: { seq: number; x: number; y: number; angle: number } | undefined;
    if (ack) {
      const i = this.history.findIndex((h) => h.seq === ack);
      if (i >= 0) {
        hist = this.history[i];
        this.history.splice(0, i + 1);
      }
    }
    if (!hist) return;
    const ex = sx - hist.x;
    const ey = sy - hist.y;
    const err = Math.hypot(ex, ey);
    this.diag.corrSum += err;
    if (err > this.diag.corrMax) this.diag.corrMax = err;
    if (err > SNAP_CORRECT_DIST) {
      this.diag.snapsHard++;
      me.x += ex;
      me.y += ey;
      me.angle = sangle;
      this.offset.x = 0;
      this.offset.y = 0;
      this.history = [];
      return;
    }
    // Replace, not accumulate: each ack measures the whole remaining error.
    this.offset.x = ex;
    this.offset.y = ey;
  }

  // ── per-frame ──────────────────────────────────────────────────────────────

  /**
   * Advance the mirror: interpolate remotes, predict self from the aim,
   * reconcile with the server, and pull orbs cosmetically.
   */
  update(dt: number, aim: Vec, wantBoost: boolean): void {
    const now = performance.now();
    const at = now - this.interpDelay;
    for (const s of this.world.snakes) {
      if (s.id === this.selfId) continue;
      const buf = this.buffers.get(s.id);
      if (!buf || !buf.length) continue;
      const snap = sample(buf, at);
      s.x = snap.x;
      s.y = snap.y;
      s.angle = snap.angle;
      s.mass = snap.mass;
      s.boosting = snap.boosting;
      s.invuln = snap.invuln ? 1 : 0;
      this.world.recordTrail(s);
    }

    const me = this.world.player;
    if (me) {
      this.world.steerToward(me, aim.x, aim.y, dt);
      me.boosting = wantBoost && me.mass > BOOST_MIN_MASS;
      this.world.moveHead(me, dt);
      const srv = this.serverSelf;
      if (srv) {
        // Bleed off whatever offset reconciliation left, a little per frame,
        // so corrections are never visible as jumps.
        const k = 1 - Math.pow(0.05, dt);
        me.x += this.offset.x * k;
        me.y += this.offset.y * k;
        this.offset.x *= 1 - k;
        this.offset.y *= 1 - k;
        me.mass = lerp(me.mass, srv.mass, 1 - Math.pow(0.001, dt));
        if (me.invuln > 0) me.invuln = Math.max(0, me.invuln - dt);
      }
      this.world.recordTrail(me);
    }

    this.world.magnet(dt);
    if (me) this.predictEats(me, now);
  }

  /**
   * Remove orbs the head has reached right away and play their effects, so
   * eating feels instant; the server's FOOD_DEL confirms, and anything not
   * confirmed in time comes back.
   */
  private predictEats(me: Snake, now: number): void {
    const reach = radiusOf(me.mass) + 3;
    const eats: EatInfo[] = [];
    for (const f of this.world.queryFood(me.x, me.y, reach + 18)) {
      if (f.id === undefined) continue;
      if (dist2(me.x, me.y, f.x, f.y) > (reach + f.r * 0.6) ** 2) continue;
      this.pendingEats.set(f.id, { food: f, t: now });
      this.world.removeFood(f);
      eats.push({ x: f.x, y: f.y, v: f.v, c: f.c });
    }
    if (eats.length) this.hooks.onEats(eats);
    for (const [id, p] of this.pendingEats) {
      if (now - p.t < EAT_CONFIRM_MS) continue;
      this.pendingEats.delete(id);
      this.eatMisses++;
      if (!this.world.foodById.has(id)) this.world.addFood(p.food);
    }
  }

  /** Foods the mirror knows about, for the debug overlay. */
  get foodCount(): number {
    return this.world.foods.length;
  }
}

function sample(buf: Snap[], at: number): Snap {
  if (buf.length === 1 || at <= buf[0]!.t) return buf[0]!;
  for (let i = 1; i < buf.length; i++) {
    const b = buf[i]!;
    const a = buf[i - 1]!;
    if (b.t >= at) {
      const t = (at - a.t) / Math.max(1, b.t - a.t);
      return {
        t: at,
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        angle: a.angle + wrapAngle(b.angle - a.angle) * t,
        mass: lerp(a.mass, b.mass, t),
        boosting: b.boosting,
        invuln: b.invuln,
      };
    }
  }
  // Past the newest snapshot: extrapolate briefly so motion never stalls.
  const last = buf[buf.length - 1]!;
  const over = Math.min(0.15, (at - last.t) / 1000);
  const speed = speedOf(last.mass, last.boosting);
  return {
    ...last,
    x: last.x + Math.cos(last.angle) * speed * over,
    y: last.y + Math.sin(last.angle) * speed * over,
  };
}

export type { Food };
