import {
  FOOD_COLORS,
  INTERP_DELAY,
  MAX_BOTS,
  MAX_NET_POINTS,
  NET_INTERVAL,
  SKINS,
  START_MASS,
  TICK,
  type Camera,
  type Floater,
  type Food,
  type Particle,
  type Phase,
  type Snake,
  type Vec,
  lerp,
  radiusOf,
} from "./model";
import { World } from "./world";
import { Renderer, desiredZoom } from "./render";
import { GameAudio } from "./audio";

export interface HudState {
  phase: Phase;
  score: number;
  best: number;
  rank: number;
  count: number;
  board: { name: string; mass: number; you: boolean }[];
  killNotice: string | null;
  deathReason: string | null;
  killerName: string | null;
  peers: number;
  joined: boolean;
  host: boolean;
}

export interface NetHandle {
  selfId: string;
  peers: { id: string; connectionState?: string }[];
  joined: boolean;
  broadcast: (data: unknown) => void;
  send: (data: unknown, peerId?: string) => void;
  onMessage: (fn: (from: string, data: unknown, channel: "state" | "reliable") => void) => () => void;
}

interface Snap {
  t: number;
  name: string;
  skin: number;
  x: number;
  y: number;
  angle: number;
  mass: number;
  boosting: boolean;
  points: Vec[];
}

type WireSnake = {
  t: "s" | "b";
  id: string;
  n: string;
  k: number;
  x: number;
  y: number;
  a: number;
  m: number;
  boost: boolean;
  p: number[];
};

type WireDeath = {
  t: "d";
  id: string;
  n: string;
  k: number;
  pellets: Food[];
};

type WireMsg = WireSnake | WireDeath | { t: "h"; id: string; n: string; k: number };

export class CoilEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly world = new World();
  private renderer = new Renderer();
  readonly audio = new GameAudio();
  phase: Phase = "menu";
  private cam: Camera = { x: 0, y: 0, z: 0.48, trauma: 0 };
  private pointer: Vec = { x: 80, y: 0 };
  private boosting = false;
  private keys = new Set<string>();
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private running = false;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private dpr = 1;
  private best = 0;
  private nick = "anon";
  private skin = 0;
  private killNotice: string | null = null;
  private deathReason: string | null = null;
  private killerName: string | null = null;
  private net: NetHandle | null = null;
  private unsub: (() => void) | null = null;
  private lastNet = 0;
  private remoteBuf = new Map<string, Snap[]>();
  private lastRemote = new Map<string, number>();
  private menuT = Math.random() * 20;
  private deathCam: Vec = { x: 0, y: 0 };
  private deathMass = START_MASS;
  private killTimer = 0;
  private lastBoostSound = 0;
  private hudListeners = new Set<(h: HudState) => void>();
  private hudAcc = 0;
  private frames = 0;
  private fpsT = 0;
  private fps = 0;
  private selfId = "local";
  private killerId: string | null = null;
  private corpse: Snake | null = null;
  private onResize = () => this.resize();
  private onBlur = () => {
    this.keys.clear();
    this.boosting = false;
    this.pointerDown = false;
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("canvas unsupported");
    this.ctx = ctx;
    this.best = readBest();
    this.world.resetLocalBots(MAX_BOTS);
    this.bind();
    this.resize();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const raw = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.acc += raw;
      let steps = 0;
      while (this.acc >= TICK && steps < 2) {
        this.tick(TICK);
        this.acc -= TICK;
        steps++;
      }
      if (this.acc > TICK * 2) this.acc = TICK;
      this.draw();
      this.frames++;
      this.fpsT += raw;
      if (this.fpsT >= 0.5) {
        this.fps = this.frames / this.fpsT;
        this.frames = 0;
        this.fpsT = 0;
      }
      this.hudAcc += raw;
      if (this.hudAcc >= 0.12) {
        this.hudAcc = 0;
        this.emitHud();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.unsub?.();
    this.unsub = null;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
  }

  setNet(net: NetHandle | null): void {
    this.unsub?.();
    this.unsub = null;
    this.net = net;
    if (!net) return;
    this.selfId = net.selfId;
    this.unsub = net.onMessage((from, data, channel) => this.onNet(from, data, channel));
  }

  play(nick: string, skin: number): void {
    this.audio.unlock();
    this.nick = nick.slice(0, 16) || "anon";
    this.skin = skin % SKINS.length;
    this.phase = "play";
    this.boosting = false;
    this.killNotice = null;
    this.deathReason = null;
    this.killerName = null;
    this.killerId = null;
    this.corpse = null;
    const id = this.net?.selfId ?? "local";
    this.selfId = id;
    this.world.spawnPlayer(id, this.nick, this.skin);
    const p = this.world.player;
    if (p) {
      this.cam.x = p.x;
      this.cam.y = p.y;
      this.pointer.x = p.x + Math.cos(p.angle) * 80;
      this.pointer.y = p.y + Math.sin(p.angle) * 80;
    }
    this.emitHud();
  }

  respawn(): void {
    if (this.phase !== "dead") return;
    this.play(this.nick, this.skin);
  }

  subscribe(fn: (h: HudState) => void): () => void {
    this.hudListeners.add(fn);
    fn(this.hud());
    return () => this.hudListeners.delete(fn);
  }

  hud(): HudState {
    const p = this.world.player;
    const alive = this.world.snakes.filter((s) => s.alive).sort((a, b) => b.mass - a.mass);
    const rank = p ? alive.findIndex((s) => s.id === p.id) + 1 : 0;
    const score = p ? Math.floor(p.mass) : this.phase === "dead" ? Math.floor(this.deathMass) : 0;
    if (score > this.best) {
      this.best = score;
      writeBest(this.best);
    }
    return {
      phase: this.phase,
      score,
      best: this.best,
      rank: rank || alive.length,
      count: alive.length,
      board: alive.slice(0, 8).map((s) => ({
        name: s.name,
        mass: Math.floor(s.mass),
        you: s.id === this.world.playerId,
      })),
      killNotice: this.killNotice,
      deathReason: this.deathReason,
      killerName: this.killerName,
      peers: this.net?.peers.length ?? 0,
      joined: this.net?.joined ?? false,
      host: this.world.host,
    };
  }

  private bind(): void {
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (e.repeat) return;
    if (this.phase === "dead" && (e.code === "Space" || e.code === "Enter")) {
      e.preventDefault();
      this.respawn();
      return;
    }
    if (e.code === "Space" || e.code === "ArrowUp") {
      if (this.phase === "play") {
        this.boosting = true;
        e.preventDefault();
      }
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    if (e.code === "Space" || e.code === "ArrowUp") {
      if (!this.pointerDown) this.boosting = false;
    }
  };

  private pointerDown = false;
  private onPointerMove = (e: PointerEvent): void => {
    this.clientToAim(e.clientX, e.clientY);
  };
  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== undefined && e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest("[data-ui]")) return;
    if (this.phase === "dead") {
      this.respawn();
      return;
    }
    if (this.phase !== "play") return;
    this.pointerDown = true;
    this.boosting = true;
    this.clientToAim(e.clientX, e.clientY);
  };
  private onPointerUp = (): void => {
    this.pointerDown = false;
    if (!this.keys.has("Space") && !this.keys.has("ArrowUp")) this.boosting = false;
  };

  private clientToAim(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    this.pointer.x = this.cam.x + x / this.cam.z;
    this.pointer.y = this.cam.y + y / this.cam.z;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private tick(dt: number): void {
    this.applyKeyboardAim();
    this.electHost();
    this.world.step(dt, this.pointer.x, this.pointer.y, this.phase === "play" && this.boosting);
    this.handleLocalEvents();
    this.pruneRemotes();
    this.interpRemotes();
    this.netTick();
    this.updateCam(dt);
    this.renderer.stepFx(dt, this.particles, this.floaters, this.cam);
    if (this.killTimer > 0) {
      this.killTimer -= dt;
      if (this.killTimer <= 0) this.killNotice = null;
    }
    if (this.phase === "play" && this.boosting) {
      const now = performance.now();
      if (now - this.lastBoostSound > 140) {
        this.audio.boost();
        this.lastBoostSound = now;
      }
    }
    this.exposeDebug();
  }

  private applyKeyboardAim(): void {
    let dx = 0;
    let dy = 0;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) dx -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) dx += 1;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) dy -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) dy += 1;
    if (!dx && !dy) return;
    const p = this.world.player;
    const origin = p ?? { x: this.cam.x, y: this.cam.y };
    this.pointer.x = origin.x + dx * 240;
    this.pointer.y = origin.y + dy * 240;
  }

  private handleLocalEvents(): void {
    for (const e of this.world.eats) {
      if (e.id === this.world.playerId) {
        this.audio.eat(e.v);
        this.burst(e.x, e.y, FOOD_COLORS[e.c % FOOD_COLORS.length]!, 5, 40);
        this.floaters.push({ x: e.x, y: e.y, text: `+${e.v}`, life: 0.7, color: "#e8eaee" });
      }
    }
    for (const d of this.world.deaths) {
      const skin = SKINS[d.snake.skin % SKINS.length]!;
      this.burst(d.snake.x, d.snake.y, skin.fill, 28, 140);
      this.cam.trauma = Math.min(1, this.cam.trauma + (d.snake.id === this.world.playerId ? 0.7 : 0.28));
      if (d.snake.id === this.world.playerId) {
        this.dieLocal(d.reason, d.killerName, d.killerId);
        this.broadcastDeath(d.snake);
      } else {
        if (d.killerId === this.world.playerId) {
          this.killNotice = `you killed ${d.snake.name}`;
          this.killTimer = 2.4;
        }
        if (d.snake.isBot && this.net) this.broadcastDeath(d.snake);
      }
    }
  }

  private dieLocal(reason: "wall" | "snake", killerName: string | null, killerId: string | null): void {
    this.audio.death();
    const p = this.world.player;
    this.deathMass = p?.mass ?? this.deathMass;
    this.deathCam = { x: p?.x ?? this.cam.x, y: p?.y ?? this.cam.y };
    this.corpse = p ? { ...p, points: p.points.map((q) => ({ ...q })) } : null;
    this.phase = "dead";
    this.deathReason = reason === "wall" ? "you hit the rim" : killerName ? `killed by ${killerName}` : "you crashed";
    this.killerName = killerName;
    this.killerId = killerId;
    this.emitHud();
  }

  private electHost(): void {
    const ids = [this.selfId, ...(this.net?.peers.map((p) => p.id) ?? [])].sort();
    this.world.host = ids[0] === this.selfId || !this.net;
    if (this.world.host) {
      const bots = this.world.snakes.filter((s) => s.isBot).length;
      if (bots < MAX_BOTS) {
        const used = new Set(this.world.snakes.map((s) => s.name.toLowerCase()));
        while (this.world.snakes.filter((s) => s.isBot).length < MAX_BOTS) this.world.spawnBot(used);
      }
    } else {
      this.world.clearBots();
    }
  }

  private pruneRemotes(): void {
    const now = performance.now();
    const live = new Set(this.net?.peers.map((p) => p.id) ?? []);
    for (const [id, t] of this.lastRemote) {
      if (now - t > 2500 || !live.has(id)) {
        this.remoteBuf.delete(id);
        this.lastRemote.delete(id);
        if (id !== this.selfId) this.world.removeSnake(id, false);
      }
    }
  }

  private netTick(): void {
    if (!this.net) return;
    const now = performance.now();
    if (now - this.lastNet < NET_INTERVAL) return;
    this.lastNet = now;
    const p = this.world.player;
    if (this.phase === "play" && p) this.net.broadcast(packSnake("s", p));
    if (this.world.host) {
      for (const s of this.world.snakes) {
        if (s.isBot && s.alive) this.net.broadcast(packSnake("b", s));
      }
    }
  }

  private onNet(_from: string, data: unknown, _channel: "state" | "reliable"): void {
    if (!data || typeof data !== "object") return;
    const msg = data as WireMsg;
    if (msg.t === "s" || msg.t === "b") this.pushSnap(msg);
    else if (msg.t === "d") this.applyDeath(msg);
  }

  private pushSnap(msg: WireSnake): void {
    if (msg.id === this.selfId) return;
    const pts = unpackPoints(msg.p);
    const snap: Snap = {
      t: performance.now(),
      name: msg.n,
      skin: msg.k,
      x: msg.x,
      y: msg.y,
      angle: msg.a,
      mass: msg.m,
      boosting: msg.boost,
      points: pts,
    };
    const buf = this.remoteBuf.get(msg.id) ?? [];
    buf.push(snap);
    while (buf.length > 12) buf.shift();
    this.remoteBuf.set(msg.id, buf);
    this.lastRemote.set(msg.id, snap.t);
  }

  private applyDeath(msg: WireDeath): void {
    if (msg.id === this.selfId) return;
    this.world.removeSnake(msg.id, false);
    this.remoteBuf.delete(msg.id);
    for (const p of msg.pellets) this.world.addFood(p);
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.25);
  }

  private broadcastDeath(s: Snake): void {
    if (!this.net) return;
    const pellets = this.world.pelletsFrom({ ...s, alive: false });
    this.net.send({
      t: "d",
      id: s.id,
      n: s.name,
      k: s.skin,
      pellets: pellets.slice(0, 72),
    } satisfies WireDeath);
  }

  private interpRemotes(): void {
    const now = performance.now();
    const at = now - INTERP_DELAY;
    for (const [id, buf] of this.remoteBuf) {
      if (id === this.selfId) continue;
      const snap = sample(buf, at) ?? buf[buf.length - 1];
      if (!snap) continue;
      const snake: Snake = {
        id,
        name: snap.name,
        skin: snap.skin,
        x: snap.x,
        y: snap.y,
        angle: snap.angle,
        mass: snap.mass,
        boosting: snap.boosting,
        points: snap.points,
        alive: true,
        isBot: id.startsWith("b-"),
        invuln: 0,
        wander: snap.angle,
        think: 0,
        avoid: 0,
        avoidDir: 1,
        boostLeft: 0,
        dropped: 0,
      };
      this.world.upsertRemote(snake);
      if (this.phase === "play") this.world.cosmeticEatNear(snap.x, snap.y, radiusOf(snap.mass) + 8);
    }
  }

  private updateCam(dt: number): void {
    if (this.phase === "menu") {
      this.menuT += dt * 0.12;
      this.cam.x = Math.cos(this.menuT) * 420;
      this.cam.y = Math.sin(this.menuT * 0.7) * 320;
    } else if (this.phase === "dead") {
      const killer = this.killerId ? this.world.snakes.find((s) => s.id === this.killerId) : null;
      const target = killer ?? this.corpse;
      if (target) {
        this.deathCam.x = lerp(this.deathCam.x, target.x, 1 - Math.pow(0.04, dt));
        this.deathCam.y = lerp(this.deathCam.y, target.y, 1 - Math.pow(0.04, dt));
      }
      this.cam.x = lerp(this.cam.x, this.deathCam.x, 1 - Math.pow(0.001, dt));
      this.cam.y = lerp(this.cam.y, this.deathCam.y, 1 - Math.pow(0.001, dt));
    } else {
      const p = this.world.player;
      if (p) {
        this.cam.x = lerp(this.cam.x, p.x, 1 - Math.pow(0.0008, dt));
        this.cam.y = lerp(this.cam.y, p.y, 1 - Math.pow(0.0008, dt));
      }
    }
    const mass = this.world.player?.mass ?? this.deathMass;
    const z = desiredZoom(mass, this.phase);
    this.cam.z = lerp(this.cam.z, z, 1 - Math.pow(0.02, dt));
  }

  private draw(): void {
    this.resize();
    this.renderer.draw(
      this.ctx,
      this.canvas.width,
      this.canvas.height,
      this.dpr,
      this.cam,
      this.world.foods,
      this.world.snakes,
      this.particles,
      this.floaters,
      this.world.playerId,
      this.phase,
      this.phase === "play" ? this.pointer : null,
    );
  }

  private burst(x: number, y: number, color: string, n: number, speed: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * speed;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0.35 + Math.random() * 0.4,
        color,
        r: 1.4 + Math.random() * 2.2,
      });
    }
  }

  private emitHud(): void {
    const h = this.hud();
    for (const fn of this.hudListeners) fn(h);
  }

  private exposeDebug(): void {
    const p = this.world.player;
    let pts = 0;
    for (const s of this.world.snakes) if (s.points.length > pts) pts = s.points.length;
    (window as unknown as { __coil?: unknown }).__coil = {
      phase: this.phase,
      score: p ? Math.floor(p.mass) : 0,
      snakes: this.world.snakes.length,
      foods: this.world.foods.length,
      host: this.world.host,
      pts,
      fps: Math.round(this.fps),
    };
  }
}

function packSnake(kind: "s" | "b", s: Snake): WireSnake {
  const pts = subsample(s.points, MAX_NET_POINTS);
  const p: number[] = [];
  for (const v of pts) {
    p.push(Math.round(v.x * 10) / 10, Math.round(v.y * 10) / 10);
  }
  return {
    t: kind,
    id: s.id,
    n: s.name,
    k: s.skin,
    x: s.x,
    y: s.y,
    a: s.angle,
    m: s.mass,
    boost: s.boosting,
    p,
  };
}

function unpackPoints(p: number[]): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i + 1 < p.length; i += 2) out.push({ x: p[i]!, y: p[i + 1]! });
  return out;
}

function subsample(pts: Vec[], max: number): Vec[] {
  if (pts.length <= max) return pts;
  const out: Vec[] = [];
  const n = pts.length - 1;
  for (let i = 0; i < max; i++) {
    const t = (i / (max - 1)) * n;
    const i0 = Math.min(n, t | 0);
    out.push(pts[i0]!);
  }
  return out;
}

function sample(buf: Snap[], at: number): Snap | null {
  if (!buf.length) return null;
  if (buf.length === 1 || at <= buf[0]!.t) return buf[0]!;
  for (let i = 1; i < buf.length; i++) {
    const b = buf[i]!;
    const a = buf[i - 1]!;
    if (b.t >= at) {
      const t = (at - a.t) / Math.max(1, b.t - a.t);
      return {
        t: at,
        name: b.name,
        skin: b.skin,
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        angle: a.angle + (b.angle - a.angle) * t,
        mass: lerp(a.mass, b.mass, t),
        boosting: b.boosting,
        points: t < 0.5 ? a.points : b.points,
      };
    }
  }
  return buf[buf.length - 1]!;
}

function readBest(): number {
  try {
    const v = localStorage.getItem("agencoil-best") ?? localStorage.getItem("coil-best");
    return v ? Number(v) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeBest(n: number): void {
  try {
    localStorage.setItem("agencoil-best", String(n));
  } catch {
    /* ignore */
  }
}
