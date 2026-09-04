import {
  COMEBACK_WINDOW_MS,
  FOOD_COLORS,
  MAX_BOTS,
  SKINS,
  START_MASS,
  WISP_BANK_MAX,
  WISP_SECS,
  dist2,
  fillOf,
  lengthOf,
  lerp,
  radiusOf,
  type Camera,
  type Floater,
  type Particle,
  type Phase,
  type Snake,
  type Vec,
} from "./model";
import { World } from "./world";
import { moveWisp, slideAlongRim, steerWisp } from "./wisp";
import { Renderer, desiredZoom } from "./render";
import { GameAudio } from "./audio";
import { ACHIEVEMENT_BY_ID } from "./achievements";
import {
  NetSession,
  defaultServerUrl,
  type ChallengeInfo,
  type DeathInfo,
  type EventInfo,
  type NetState,
  type ProfileInfo,
  type StatsInfo,
} from "./net";

export interface ReplayFrame {
  t: number;
  snakes: { id: string; color: string; r: number; pts: Vec[]; me: boolean }[];
}

export interface HudState {
  phase: Phase;
  score: number;
  best: number;
  rank: number;
  count: number;
  kills: number;
  board: { name: string; mass: number; you: boolean; bounty: number }[];
  daily: { name: string; best: number }[];
  profile: ProfileInfo | null;
  challenges: ChallengeInfo[];
  /** Golden swarm in progress: direction label and seconds left. */
  event: { dir: string; left: number } | null;
  /** Close-call combo popup (0 when none). */
  nearCombo: number;
  nearBonus: number;
  /** Seconds left to take the comeback respawn, 0 when unavailable. */
  comebackLeft: number;
  /** A beat after death where the card should wait. */
  deathBeat: boolean;
  bountyOnYou: number;
  /** Who the menu camera is following. */
  watchingTop: { name: string; mass: number } | null;
  /** The last seconds before death, for the death card replay. */
  replay: ReplayFrame[] | null;
  deathAt: Vec | null;
  /** Your killer, if still alive, for a one-tap rematch spawn. */
  rematch: { nid: number; name: string } | null;
  /** Afterlife: bank so far and seconds left; null outside the wisp phase. */
  wisp: { bank: number; secsLeft: number } | null;
  /** Starting length banked by the last wisp, shown on the death card. */
  banked: number;
  /** The Boss Hour snake while it lives. */
  boss: { hp: number; dir: string } | null;
  /** The nearest goal, for the always-on progress bar. */
  goal: { text: string; frac: number } | null;
  /** "40 short of your best" style line for a near miss of a record or the top. */
  nearWin: string | null;
  /** Achievement ids earned during this life, oldest first. */
  unlocked: string[];
  /** A "beat my run" target from the link that opened the game. */
  beat: { by: string; target: number; done: boolean } | null;
  /** Tutorial hint for a first life, if any. */
  hint: string | null;
  firstLife: boolean;
  party: { name: string; mass: number }[];
  arenaMode: { id: number; secsLeft: number; secsToNext: number };
  killNotice: string | null;
  /** Recent notable deaths, newest last. */
  feed: string[];
  /** Your rank when you died, and how many were in the arena. */
  deathRank: number;
  deathCount: number;
  /** Today's best run, from the server. */
  topToday: { name: string; best: number } | null;
  /** Top snakes you can watch after dying. */
  watchable: { nid: number; name: string }[];
  watching: number | null;
  deathReason: string | null;
  killerName: string | null;
  players: number;
  mode: NetState;
  /** The server process this session is on (arena name, or the function's deployment id). */
  arena: string;
  rtt: number;
  verificationError: string | null;
}

export type Controls = "point" | "stick";

export interface Stick {
  ox: number;
  oy: number;
  x: number;
  y: number;
}

export interface Look {
  name: string;
  skin: number;
  bands?: string[];
  trail?: number;
  deathFx?: number;
  /** A one-time account ticket from the site; the server links the profile. */
  identity?: { origin: string; ticket: string };
}

const ZOOM_MIN = 0.55;
const ZOOM_MAX = 1.7;
/** How far ahead of the head the aim point sits, in world units. */
const AIM_REACH = 240;
/** A cursor this close (CSS px) to the drawn wisp is "straight on", not a turn. */
const WISP_AIM_DEAD_PX = 14;
/** The camera eases onto the wisp for this long, then sits on it exactly. */
const WISP_CAM_EASE_MS = 500;
/** The client ends a wisp itself if the server's end never arrives. */
const WISP_TIMEOUT_MS = (WISP_SECS + 3) * 1000;
const SPAWN_TIMEOUT_MS = 4000;

interface DeathFx {
  pts: Vec[];
  color: string;
  t: number;
  dur: number;
  next: number;
}

export class CoilEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private renderer = new Renderer();
  readonly audio = new GameAudio();
  phase: Phase = "menu";
  private net: NetSession | null = null;
  private local: World | null = null;
  private cam: Camera = { x: 0, y: 0, z: 0.55, trauma: 0 };
  private pointer: Vec = { x: 80, y: 0 };
  /** Cursor position relative to the canvas centre, in CSS pixels. */
  private aimScreen: Vec | null = null;
  private boosting = false;
  private holdBoost = false;
  private keys = new Set<string>();
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private running = false;
  private raf = 0;
  private last = 0;
  private dpr = 1;
  private best = 0;
  private look: Look = { name: "anon", skin: 0 };
  private kills = 0;
  private streak = 0;
  private lastKillAt = 0;
  private killNotice: string | null = null;
  private deathReason: string | null = null;
  private killerName: string | null = null;
  private killerId: string | null = null;
  private corpse: Snake | null = null;
  private deathFx: DeathFx | null = null;
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
  private zoomMul = 1;
  private stats: StatsInfo | null = null;
  controls: Controls = "point";
  private stick: Stick | null = null;
  private stickId: number | null = null;
  /** The finger that steers; any second finger boosts while it is down. */
  private steerId: number | null = null;
  private boostFingers = new Set<number>();
  private insets = { top: 0, bottom: 0 };
  private watchNid: number | null = null;
  private spawnWait = 0;
  private feed: { text: string; t: number }[] = [];
  private profile: ProfileInfo | null = null;
  private challenges: ChallengeInfo[] = [];
  private event: EventInfo | null = null;
  private near = { combo: 0, bonus: 0, t: 0 };
  private comebackOffer = 0;
  private deathBeatUntil = 0;
  /** The death card ignores Space, Enter and clicks until then: no accidental respawn. */
  private respawnArmedAt = 0;
  private lastEatAt = 0;
  private eatCombo = 0;
  private spawnedAt = 0;
  private firstKillDone = false;
  private emotes = new Map<string, { id: number; until: number }>();
  private hitStopUntil = 0;
  private wisp: { x: number; y: number; angle: number; trail: Vec[] } | null = null;
  private wispSrv: { x: number; y: number } | null = null;
  private wispBank = 0;
  private wispSecs = 0;
  private wispWanted = false;
  private wispStartedAt = 0;
  /** A steering key was held this tick, so the aim point is live, not a leftover. */
  private keyAim = false;
  private unlocked: string[] = [];
  private banked = 0;
  private nearWin: string | null = null;
  private beat: { by: string; target: number; done: boolean } | null = null;
  private replayBuf: ReplayFrame[] = [];
  private replayFrozen: ReplayFrame[] | null = null;
  private replayAcc = 0;
  private qualityScale = 1;
  private lowFpsT = 0;
  private highFpsT = 0;
  private deathRank = 0;
  private deathCount = 0;
  private dbgWall = 0;
  private dbgSnake = 0;
  private verificationError: string | null = null;
  private onResize = () => this.resize();
  private onBlur = () => {
    this.keys.clear();
    this.boosting = false;
    this.pointerDown = false;
    this.holdBoost = false;
    this.boostFingers.clear();
    this.steerId = null;
    this.stick = null;
    this.stickId = null;
  };

  constructor(canvas: HTMLCanvasElement, serverUrl: string | null = defaultServerUrl()) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("canvas unsupported");
    this.ctx = ctx;
    this.best = readBest();
    try {
      const q = new URLSearchParams(window.location.search);
      const target = Number(q.get("beat"));
      const by = (q.get("by") ?? "").slice(0, 16);
      if (target > 0 && by) this.beat = { by, target, done: false };
    } catch {
      /* ignore */
    }
    if (serverUrl) {
      this.net = new NetSession(serverUrl, {
        onState: (s) => this.onNetState(s),
        onSpawned: (s) => this.onSpawned(s),
        onDeath: (d) => this.onNetDeath(d),
        onEats: (eats) => {
          for (const e of eats) this.eatFx(e.x, e.y, e.v, e.c);
        },
        onStats: (s) => {
          this.stats = s;
          const b = this.world.snakes.find((x) => x.boss);
          if (b && s.boss) {
            b.hp = s.boss.hp;
            b.hpMax = 100;
          }
        },
        onWisp: (x, y, bank, secsLeft) => {
          this.wispSrv = { x, y };
          if (bank > this.wispBank) {
            const at = this.wisp ?? { x, y };
            this.floaters.push({
              x: at.x,
              y: at.y - 20,
              text: `+${bank - this.wispBank}`,
              life: 0.8,
              color: "#bfe9ff",
            });
            this.audio.eat(bank - this.wispBank, 2);
          }
          this.wispBank = bank;
          this.wispSecs = secsLeft;
          if (secsLeft === 0) {
            const full = bank >= WISP_BANK_MAX;
            if (this.phase === "wisp") this.endWisp();
            else {
              // Ended before the death beat let it begin: there is no wisp to fly.
              this.wispWanted = false;
              this.banked = bank;
            }
            // The card still shows: comeback, rematch and play again stay on offer.
            if (full) this.pushFeed(`wisp full: +${bank} banked for your next life`);
          }
        },
        onProfile: (p) => {
          this.profile = p;
          this.emitHud();
        },
        onChallenges: (c) => {
          this.challenges = c;
          this.emitHud();
        },
        onNear: (combo, bonus) => this.onNear(combo, bonus),
        onEvent: (e) => {
          this.event = e;
          this.pushFeed("golden swarm spotted, check the map");
        },
        onEmote: (nid, id) => {
          this.emotes.set(String(nid), { id, until: performance.now() + 2200 });
        },
        onNotice: (kind, text) => {
          if (kind === 3) {
            this.comebackOffer = performance.now() + COMEBACK_WINDOW_MS;
            return;
          }
          this.pushFeed(text);
          if (kind === 2) this.audio.kill();
        },
        onGateRequired: (message) => this.onGateRequired(message),
        onAchieve: (id) => {
          const a = ACHIEVEMENT_BY_ID.get(id);
          this.unlocked = [...this.unlocked, id];
          this.pushFeed(`achievement: ${a ? `${a.icon} ${a.name}` : id}`);
          this.audio.kill();
          this.emitHud();
        },
      });
      this.net.connect();
    } else {
      this.localWorld();
    }
    this.bind();
    this.resize();
  }

  /** The arena being drawn: the server mirror when online, else local bots. */
  get world(): World {
    // A local life in progress keeps its world even if the server comes up
    // mid-game; the next Play goes online.
    if (this.local?.player) return this.local;
    if (this.online) return this.net!.world;
    return this.localWorld();
  }

  private get online(): boolean {
    return this.net?.state === "online";
  }

  private localWorld(): World {
    if (!this.local) {
      this.local = new World(true);
      this.local.host = true;
      this.local.resetLocalBots(MAX_BOTS);
    }
    return this.local;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      // One simulation step per displayed frame, by the real elapsed time,
      // as slither.io does. A fixed 60 Hz step drifted against the display
      // clock (0 or 2 steps on some frames) and moved every other frame on
      // 120 Hz screens; both read as stutter. Every consumer of dt below is
      // frame-rate independent. Long gaps (tab hidden) are clamped.
      const raw = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (raw > 0) this.tick(Math.min(raw, 1 / 20));
      this.draw();
      this.frames++;
      this.fpsT += raw;
      if (this.fpsT >= 0.5) {
        this.fps = this.frames / this.fpsT;
        this.frames = 0;
        this.fpsT = 0;
        this.adaptQuality();
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
    this.audio.stopMusic();
    this.audio.setDanger(0);
    this.audio.setHeartbeat(false);
    this.net?.close();
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("wheel", this.onWheel);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  /** Hold-to-boost from an on-screen control (touch). */
  setBoost(on: boolean): void {
    this.holdBoost = on;
    this.syncBoost();
  }

  /** Leave the wisp: the death card takes over with whatever was banked. */
  endWisp(): void {
    if (this.phase !== "wisp") return;
    this.banked = this.wispBank;
    this.wisp = null;
    this.wispWanted = false;
    this.phase = "dead";
    this.boosting = false;
    this.holdBoost = false;
    // A key or button held to steer the wisp must not pick a card option.
    this.respawnArmedAt = performance.now() + 700;
    this.emitHud();
  }

  setCrew(tag: string): void {
    this.net?.setCrew(tag);
  }

  /** Send a quick reaction; also shown locally at once. */
  emote(id: number): void {
    if (this.phase !== "play") return;
    this.net?.emote(id);
    const p = this.world.player;
    if (p) this.emotes.set(p.id, { id, until: performance.now() + 2200 });
  }

  /** After dying, follow one of the leaderboard snakes (null = your killer). */
  watch(nid: number | null): void {
    this.watchNid = nid;
    this.emitHud();
  }

  /** Safe-area insets in CSS pixels, so canvas HUD stays clear of notches. */
  setInsets(top: number, bottom: number): void {
    this.insets = { top, bottom };
  }

  setControls(mode: Controls): void {
    this.controls = mode;
    this.stick = null;
    this.stickId = null;
  }

  play(look: Look, comeback = false, nearNid = 0): void {
    this.audio.unlock();
    this.audio.startMusic();
    this.look = {
      name: look.name.slice(0, 16) || "anon",
      skin: look.skin % SKINS.length,
      bands: look.bands,
      trail: look.trail ?? 0,
      deathFx: look.deathFx ?? 0,
      identity: look.identity,
    };
    this.unlocked = [];
    this.comebackOffer = 0;
    this.near = { combo: 0, bonus: 0, t: 0 };
    this.kills = 0;
    this.streak = 0;
    this.killNotice = null;
    this.deathReason = null;
    this.killerName = null;
    this.killerId = null;
    this.corpse = null;
    this.deathFx = null;
    this.boosting = false;
    this.watchNid = null;
    this.verificationError = null;
    if (this.net && this.net.state !== "offline") {
      // Online, or still connecting: ask the server and wait for SPAWNED.
      // If nothing arrives within SPAWN_TIMEOUT_MS the tick starts a local game.
      this.spawnWait = performance.now();
      this.net.play(this.look, comeback, nearNid);
      return;
    }
    this.spawnLocal();
  }

  private spawnLocal(): void {
    const w = this.localWorld();
    const s = w.spawnPlayer("local", this.look.name, this.look.skin, this.look.bands);
    s.trail = this.look.trail;
    s.deathFx = this.look.deathFx;
    this.phase = "play";
    this.spawnedAt = performance.now();
    this.snapCamTo(s);
    this.emitHud();
  }

  private onSpawned(s: Snake): void {
    this.spawnWait = 0;
    this.phase = "play";
    this.spawnedAt = performance.now();
    this.replayBuf = [];
    this.replayFrozen = null;
    this.wisp = null;
    this.wispSrv = null;
    this.wispWanted = false;
    this.wispBank = 0;
    this.banked = 0;
    this.nearWin = null;
    this.snapCamTo(s);
    this.emitHud();
  }

  private snapCamTo(s: Snake): void {
    this.cam.x = s.x;
    this.cam.y = s.y;
    this.aimScreen = null;
    this.pointer.x = s.x + Math.cos(s.angle) * AIM_REACH;
    this.pointer.y = s.y + Math.sin(s.angle) * AIM_REACH;
  }

  respawn(comeback = false, rematch = false): void {
    const near = rematch && this.killerId ? Number(this.killerId) || 0 : 0;
    if (this.phase === "wisp") this.endWisp();
    if (this.phase !== "dead") return;
    if (performance.now() < this.deathBeatUntil) return;
    this.play(this.look, comeback && this.comebackOffer > performance.now(), near);
  }

  /** Current session party code (friends spawn together). */
  get party(): string {
    return this.net?.party ?? "";
  }
  setParty(code: string): void {
    if (this.net) this.net.party = code;
  }

  /** Get a short-lived, server-signed play ticket from a Turnstile response. */
  async authorize(turnstileToken: string): Promise<void> {
    if (this.net && this.net.state !== "offline") await this.net.authorize(turnstileToken);
  }

  subscribe(fn: (h: HudState) => void): () => void {
    this.hudListeners.add(fn);
    fn(this.hud());
    return () => this.hudListeners.delete(fn);
  }

  hud(): HudState {
    const world = this.world;
    const p = world.player;
    const alive = world.snakes.filter((s) => s.alive).sort((a, b) => b.mass - a.mass);
    const score = p ? Math.floor(p.mass) : this.phase === "dead" ? Math.floor(this.deathMass) : 0;
    if (score > this.best) {
      this.best = score;
      writeBest(this.best);
    }
    const st = this.online && world !== this.local ? this.stats : null;
    const rank = st ? st.rank : p ? alive.findIndex((s) => s.id === p.id) + 1 : 0;
    const count = st ? st.count : alive.length;
    const board = st
      ? st.board.map((b) => ({
          name: b.name,
          mass: b.mass,
          you: b.nid === this.net!.selfNid,
          bounty: b.bounty,
        }))
      : alive.slice(0, 10).map((s) => ({
          name: s.name,
          mass: Math.floor(s.mass),
          you: s.id === world.playerId,
          bounty: 0,
        }));
    const now = performance.now();
    const ev = this.event;
    const evLeft = ev ? Math.max(0, ev.left - (now - ev.at) / 1000) : 0;
    const me = st ? st.board.find((b) => b.nid === this.net!.selfNid) : undefined;
    return {
      phase: this.phase,
      score,
      best: this.best,
      rank: rank || count,
      count,
      kills: this.kills,
      board,
      daily: st?.daily ?? [],
      profile: this.profile,
      challenges: this.challenges,
      event: ev && evLeft > 0 ? { dir: this.compass(ev.x, ev.y), left: Math.round(evLeft) } : null,
      nearCombo: now - this.near.t < 1500 ? this.near.combo : 0,
      nearBonus: this.near.bonus,
      comebackLeft:
        this.phase === "dead" && this.comebackOffer > now
          ? Math.ceil((this.comebackOffer - now) / 1000)
          : 0,
      deathBeat: this.phase === "dead" && now < this.deathBeatUntil,
      bountyOnYou: me?.bounty ?? 0,
      watchingTop:
        this.phase === "menu" && st?.board[0]
          ? { name: st.board[0].name, mass: st.board[0].mass }
          : null,
      replay: this.phase === "dead" ? this.replayFrozen : null,
      deathAt: this.phase === "dead" ? this.corpse : null,
      rematch: this.rematchTarget(),
      wisp: this.phase === "wisp" ? { bank: this.wispBank, secsLeft: this.wispSecs } : null,
      banked: this.banked,
      unlocked: this.unlocked,
      boss: st?.boss ? { hp: st.boss.hp, dir: this.compass(st.boss.x, st.boss.y) } : null,
      goal: this.goalNow(),
      nearWin: this.phase === "dead" ? this.nearWin : null,
      beat: this.beat,
      hint: this.hint(),
      firstLife: this.isFirstLife(),
      party: this.stats?.party ?? [],
      arenaMode: this.stats?.mode ?? { id: 0, secsLeft: 0, secsToNext: 0 },
      killNotice: this.killNotice,
      feed: this.feed.map((f) => f.text),
      deathRank: this.deathRank,
      deathCount: this.deathCount,
      topToday: this.stats?.daily[0] ?? null,
      watchable: st ? st.board.slice(0, 3).map((b) => ({ nid: b.nid, name: b.name })) : [],
      watching: this.watchNid,
      deathReason: this.deathReason,
      killerName: this.killerName,
      players: this.stats?.clients ?? (this.online ? 1 : 0),
      mode: this.net?.state ?? "offline",
      arena: this.net?.arenaName ?? "",
      rtt: this.net?.rttMs ?? 0,
      verificationError: this.verificationError,
    };
  }

  private onGateRequired(message: string): void {
    this.spawnWait = 0;
    this.net?.idle();
    this.phase = "menu";
    this.verificationError = message;
    this.emitHud();
  }

  private onNetState(s: NetState): void {
    // A wisp lives on the server; without the connection there is nothing to fly.
    if (s !== "online" && this.phase === "wisp") this.endWisp();
    if (s === "offline" && this.spawnWait) {
      this.spawnWait = 0;
      this.net?.idle();
      this.spawnLocal();
    } else if (s === "offline" && this.phase === "play" && !this.local?.player) {
      // Lost the server mid-game: the snake stays there in its grace period,
      // but we cannot steer it, so end this life here.
      this.dieLocal("snake", null, null, "connection lost");
    }
    this.emitHud();
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
    window.addEventListener("wheel", this.onWheel, { passive: true });
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = (): void => {
    if (document.visibilityState === "visible") this.audio.unlock();
    else this.onBlur();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (e.repeat) return;
    if (this.phase === "wisp" && e.code === "Enter") {
      e.preventDefault();
      this.endWisp();
      return;
    }
    if (this.phase === "dead" && (e.code === "Space" || e.code === "Enter")) {
      e.preventDefault();
      if (performance.now() >= this.respawnArmedAt) this.respawn();
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code))
      e.preventDefault();
    if (this.phase === "play" && /^Digit[1-4]$/.test(e.code)) this.emote(Number(e.code[5]) - 1);
    this.keys.add(e.code);
    this.syncBoost();
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    this.syncBoost();
  };

  private pointerDown = false;
  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch" && !this.pointerDown) return;
    if (e.pointerType === "touch" && this.steerId !== null && e.pointerId !== this.steerId) return;
    if (e.pointerType === "touch" && this.controls === "stick") {
      if (this.stick && e.pointerId === this.stickId) {
        this.stick.x = e.clientX;
        this.stick.y = e.clientY;
        this.stickToAim();
      }
      return;
    }
    this.clientToAim(e.clientX, e.clientY);
  };

  private stickToAim(): void {
    const st = this.stick;
    const p = this.world.player;
    if (!st || !p) return;
    const dx = st.x - st.ox;
    const dy = st.y - st.oy;
    const d = Math.hypot(dx, dy);
    if (d < 6) return;
    this.aimScreen = null;
    this.pointer.x = p.x + (dx / d) * AIM_REACH;
    this.pointer.y = p.y + (dy / d) * AIM_REACH;
  }
  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== undefined && e.button !== 0) return;
    const t = e.target;
    if (t instanceof Element && t.closest("[data-ui]")) return;
    if (this.phase === "dead") {
      if (performance.now() >= this.respawnArmedAt) this.respawn();
      return;
    }
    if (this.phase !== "play" && this.phase !== "wisp") return;
    if (e.pointerType === "touch") {
      // First finger steers; any further finger boosts while it is down.
      if (this.steerId !== null && this.steerId !== e.pointerId) {
        this.boostFingers.add(e.pointerId);
        this.syncBoost();
        return;
      }
      this.steerId = e.pointerId;
    } else {
      // A mouse click boosts.
      this.holdBoost = true;
    }
    this.pointerDown = true;
    if (e.pointerType === "touch" && this.controls === "stick") {
      this.stick = { ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
      this.stickId = e.pointerId;
      return;
    }
    this.clientToAim(e.clientX, e.clientY);
    this.syncBoost();
  };
  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") this.holdBoost = false;
    if (this.boostFingers.delete(e.pointerId)) {
      this.syncBoost();
      return;
    }
    if (e.pointerId === this.stickId) {
      this.stick = null;
      this.stickId = null;
    }
    if (e.pointerId === this.steerId) this.steerId = null;
    this.pointerDown = false;
    this.syncBoost();
  };
  private onWheel = (e: WheelEvent): void => {
    const k = Math.exp(-e.deltaY * 0.0012);
    this.zoomMul = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomMul * k));
  };

  private syncBoost(): void {
    const key = this.keys.has("Space") || this.keys.has("ArrowUp") || this.keys.has("ShiftLeft");
    this.boosting =
      (this.phase === "play" || this.phase === "wisp") &&
      (this.holdBoost || key || this.boostFingers.size > 0);
  }

  /**
   * Like slither.io, the cursor sets a direction from the head, not a point in
   * the world: a still mouse keeps the snake on a straight line.
   */
  private clientToAim(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.aimScreen = {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
    this.refreshAim();
  }

  private refreshAim(): void {
    const a = this.aimScreen;
    // The wisp steers like a head: the cursor is a direction from it, never
    // a point it can reach and stall on.
    const p = this.world.player ?? (this.phase === "wisp" ? this.wisp : null);
    if (!a) return;
    if (!p) {
      this.pointer.x = this.cam.x + a.x / this.cam.z;
      this.pointer.y = this.cam.y + a.y / this.cam.z;
      return;
    }
    const hx = (p.x - this.cam.x) * this.cam.z;
    const hy = (p.y - this.cam.y) * this.cam.z;
    const dx = a.x - hx;
    const dy = a.y - hy;
    const d = Math.hypot(dx, dy);
    // Right on the head (or the wisp) means keep going, not turn around.
    if (d < (p === this.wisp ? WISP_AIM_DEAD_PX : 4)) return;
    this.pointer.x = p.x + (dx / d) * AIM_REACH;
    this.pointer.y = p.y + (dy / d) * AIM_REACH;
  }

  /**
   * Dynamic resolution: under a sustained 45 fps the canvas renders at 80%
   * then 65% of its pixel size; a sustained 57 fps climbs back. Weak GPUs are
   * fill-rate bound, so this is worth far more than trimming draw calls.
   */
  private adaptQuality(): void {
    if (this.phase !== "play") return;
    if (this.fps < 45) {
      this.lowFpsT += 0.5;
      this.highFpsT = 0;
    } else if (this.fps > 57) {
      this.highFpsT += 0.5;
      this.lowFpsT = 0;
    } else {
      this.lowFpsT = 0;
      this.highFpsT = 0;
    }
    if (this.lowFpsT >= 2 && this.qualityScale > 0.65) {
      this.qualityScale = Math.max(0.65, this.qualityScale - 0.2);
      this.lowFpsT = 0;
      this.resize();
    } else if (this.highFpsT >= 6 && this.qualityScale < 1) {
      this.qualityScale = Math.min(1, this.qualityScale + 0.2);
      this.highFpsT = 0;
      this.resize();
    }
  }

  /** Snapshot nearby snakes ten times a second for the death replay. */
  private recordReplay(dt: number): void {
    if (this.phase !== "play") return;
    this.replayAcc += dt;
    if (this.replayAcc < 0.1) return;
    this.replayAcc = 0;
    const me = this.world.player;
    if (!me) return;
    const range = 1500;
    const frame: ReplayFrame = { t: performance.now(), snakes: [] };
    for (const s of this.world.snakes) {
      if (!s.alive || dist2(s.x, s.y, me.x, me.y) > range * range) continue;
      const src = s.points;
      const n = Math.min(40, src.length);
      const pts: Vec[] = [];
      for (let i = 0; i < n; i++) {
        const p = src[Math.round((i / Math.max(1, n - 1)) * (src.length - 1))]!;
        pts.push({ x: p.x, y: p.y });
      }
      pts.push({ x: s.x, y: s.y });
      frame.snakes.push({
        id: s.id,
        color: fillOf(s),
        r: radiusOf(s.mass),
        pts,
        me: s.id === me.id,
      });
    }
    this.replayBuf.push(frame);
    if (this.replayBuf.length > 60) this.replayBuf.shift();
  }

  /** Predict the wisp from the aim; the server's position bleeds in. */
  private stepWisp(dt: number): void {
    const w = this.wisp;
    if (!w || this.phase !== "wisp") return;
    if (this.aimScreen !== null || this.keyAim) {
      // A live aim (cursor, finger, or a held key) is a direction from the wisp.
      steerWisp(w, this.pointer, dt);
    } else {
      // No input: fly on. A released key leaves its aim point behind, so it
      // is carried along ahead of the wisp; it can never be passed and turned
      // back toward, which is what used to leave the wisp jittering in place.
      this.pointer.x = w.x + Math.cos(w.angle) * AIM_REACH;
      this.pointer.y = w.y + Math.sin(w.angle) * AIM_REACH;
    }
    moveWisp(w, this.boosting, dt);
    slideAlongRim(w);
    if (this.wispSrv) {
      const k = 1 - Math.pow(0.05, dt);
      w.x += (this.wispSrv.x - w.x) * k;
      w.y += (this.wispSrv.y - w.y) * k;
    }
    w.trail.push({ x: w.x, y: w.y });
    if (w.trail.length > 28) w.trail.shift();
  }

  /** The closest unfinished goal: a skin unlock, the active quest step or the next level. */
  private goalNow(): { text: string; frac: number } | null {
    const p = this.world.player;
    const score = p ? Math.floor(p.mass) : 0;
    const best = Math.max(this.profile?.best ?? 0, this.best, score);
    const cands: { text: string; frac: number }[] = [];
    for (const u of [120, 300, 600, 1200]) {
      if (best < u) {
        cands.push({
          text: `skin at ${u} · ${u - Math.max(best, score)} to go`,
          frac: Math.max(best, score) / u,
        });
        break;
      }
    }
    const step = this.challenges.find((c) => !c.done);
    if (step)
      cands.push({
        text: `quest: ${step.text} · ${Math.min(step.progress, step.target)}/${step.target}`,
        frac: Math.min(1, step.progress / step.target),
      });
    if (this.beat && !this.beat.done)
      cands.push({
        text: `beat ${this.beat.by} · ${score}/${this.beat.target}`,
        frac: score / this.beat.target,
      });
    if (!cands.length) return null;
    return cands.sort((a, b) => b.frac - a.frac)[0]!;
  }

  private rematchTarget(): { nid: number; name: string } | null {
    if (this.phase !== "dead" || !this.killerId || !this.online) return null;
    const k = this.world.snakes.find((s) => s.id === this.killerId && s.alive);
    if (!k) return null;
    const nid = Number(this.killerId);
    return Number.isFinite(nid) && nid > 0 ? { nid, name: k.name } : null;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5) * this.qualityScale;
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private tick(dt: number): void {
    this.refreshAim();
    this.keyAim = this.applyKeyboardAim();
    const boost = (this.phase === "play" || this.phase === "wisp") && this.boosting;
    const localLife = this.local?.player != null;
    // The server did not answer Play in time: start a local game instead.
    if (this.spawnWait && performance.now() - this.spawnWait > SPAWN_TIMEOUT_MS) {
      this.spawnWait = 0;
      this.net?.idle();
      this.spawnLocal();
    }
    if (this.online && !localLife) {
      const net = this.net!;
      net.update(dt, this.pointer, boost);
      const me = net.world.player;
      this.stepWisp(dt);
      const angle = me
        ? Math.atan2(this.pointer.y - me.y, this.pointer.x - me.x)
        : (this.wisp?.angle ?? 0);
      const cssW = this.canvas.width / this.dpr;
      const cssH = this.canvas.height / this.dpr;
      net.sendInput(angle, boost, {
        cx: this.cam.x,
        cy: this.cam.y,
        hw: cssW / (2 * this.cam.z) + 40,
        hh: cssH / (2 * this.cam.z) + 40,
      });
    } else {
      const w = this.localWorld();
      w.step(dt, this.pointer.x, this.pointer.y, boost);
      this.handleLocalEvents(w);
      // Keep the server mirror current so the switch back is seamless.
      if (this.online) this.net!.update(dt, this.pointer, false);
    }
    this.trailFx(dt);
    this.stepDeathFx(dt);
    this.updateCam(dt);
    // The moment of death plays out in slow motion for a beat.
    const nowMs = performance.now();
    const fxDt =
      (this.phase === "dead" && nowMs < this.deathBeatUntil) || nowMs < this.hitStopUntil
        ? dt * 0.35
        : dt;
    this.recordReplay(dt);
    if (this.beat && !this.beat.done && this.phase === "play") {
      const p = this.world.player;
      if (p && p.mass >= this.beat.target) {
        this.beat.done = true;
        this.pushFeed(`you beat ${this.beat.by}'s ${this.beat.target}!`);
        this.audio.kill();
      }
    }
    if (this.phase === "dead" && this.wispWanted && this.wispSrv && nowMs > this.deathBeatUntil) {
      this.phase = "wisp";
      this.wispStartedAt = nowMs;
      this.wisp = {
        x: this.wispSrv.x,
        y: this.wispSrv.y,
        angle: this.corpse?.angle ?? 0,
        trail: [],
      };
      // Whatever the cursor was doing to the snake, the wisp starts straight.
      this.pointer.x = this.wisp.x + Math.cos(this.wisp.angle) * AIM_REACH;
      this.pointer.y = this.wisp.y + Math.sin(this.wisp.angle) * AIM_REACH;
      this.emitHud();
    }
    // The server ends the wisp; if that word never arrives, the card must still come.
    if (this.phase === "wisp" && nowMs - this.wispStartedAt > WISP_TIMEOUT_MS) this.endWisp();
    this.renderer.stepFx(fxDt, this.particles, this.floaters, this.cam);
    this.audioCues();
    if (this.killTimer > 0) {
      this.killTimer -= dt;
      if (this.killTimer <= 0) this.killNotice = null;
    }
    if (this.feed.length && performance.now() - this.feed[0]!.t > 7000) this.feed.shift();
    if (this.phase === "play" && this.world.player?.boosting) {
      const now = performance.now();
      if (now - this.lastBoostSound > 140) {
        this.audio.boost();
        this.lastBoostSound = now;
      }
    }
    this.exposeDebug();
  }

  /** Point the aim along the held steering keys; true when any are held. */
  private applyKeyboardAim(): boolean {
    let dx = 0;
    let dy = 0;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) dx -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) dx += 1;
    if (this.keys.has("KeyW")) dy -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) dy += 1;
    if (!dx && !dy) return false;
    const p = this.world.player;
    const origin = p ??
      (this.phase === "wisp" ? this.wisp : null) ?? { x: this.cam.x, y: this.cam.y };
    this.aimScreen = null;
    this.pointer.x = origin.x + dx * AIM_REACH;
    this.pointer.y = origin.y + dy * AIM_REACH;
    return true;
  }

  private eatFx(x: number, y: number, v: number, c: number): void {
    const now = performance.now();
    this.eatCombo = now - this.lastEatAt < 900 ? this.eatCombo + 1 : 0;
    this.lastEatAt = now;
    this.audio.eat(v, this.eatCombo);
    this.burst(x, y, FOOD_COLORS[c % FOOD_COLORS.length]!, v >= 3 ? 10 : 4, 40);
    if (v >= 2)
      this.floaters.push({ x, y, text: `+${Math.round(v)}`, life: 0.7, color: "#e8eaee" });
  }

  private handleLocalEvents(w: World): void {
    for (const e of w.eats) if (e.id === w.playerId) this.eatFx(e.x, e.y, e.v, e.c);
    for (const d of w.deaths) {
      if (d.reason === "wall") this.dbgWall++;
      else this.dbgSnake++;
      this.deathBurst(d.snake);
      const mine = d.snake.id === w.playerId;
      const byMe = d.killerId === w.playerId;
      if (mine) {
        this.dieLocal(d.reason, d.killerName, d.killerId);
      } else if (byMe) {
        this.registerKill(d.snake.name);
      }
      if (mine || byMe || d.snake.mass >= 150) {
        const who = mine ? "you" : d.snake.name;
        const by = byMe ? "you" : d.killerName;
        const len = Math.floor(d.snake.mass);
        this.pushFeed(
          d.reason === "wall"
            ? `${who} hit the rim at ${len}`
            : by
              ? `${by} took down ${who} (${len})`
              : `${who} crashed at ${len}`,
        );
      }
    }
  }

  private onNetDeath(d: DeathInfo): void {
    const net = this.net!;
    const id = String(d.nid);
    const s = net.world.snakes.find((x) => x.id === id);
    if (s) this.deathBurst(s);
    const mine = d.nid === net.selfNid;
    const byMe = d.killerNid !== 0 && d.killerNid === net.selfNid;
    if (mine) {
      this.dieLocal(d.reason, d.killerName || null, d.killerNid ? String(d.killerNid) : null);
    } else if (byMe) {
      this.registerKill(d.name);
    }
    // Notable deaths make the feed: anything you were part of, or a big one.
    if (mine || byMe || d.finalLen >= 150) {
      const who = mine ? "you" : d.name;
      const by = byMe ? "you" : d.killerName;
      this.pushFeed(
        d.reason === "wall"
          ? `${who} hit the rim at ${d.finalLen}`
          : by
            ? `${by} took down ${who} (${d.finalLen})`
            : `${who} crashed at ${d.finalLen}`,
      );
    }
  }

  private isFirstLife(): boolean {
    if (this.profile) return this.profile.games === 0;
    try {
      return !localStorage.getItem("agencoil-played");
    } catch {
      return false;
    }
  }

  /** Timed coaching for a first life; null otherwise. */
  private hint(): string | null {
    if (this.phase !== "play" || !this.isFirstLife()) return null;
    const t = (performance.now() - this.spawnedAt) / 1000;
    if (t < 5) return "move the mouse or drag to steer";
    if (t < 10) return "hold click, space or a second finger to boost";
    const p = this.world.player;
    if (p && !this.firstKillDone) {
      const prey = this.world.snakes.find(
        (o) =>
          o.id !== p.id &&
          o.alive &&
          o.mass < p.mass * 0.9 &&
          dist2(o.x, o.y, p.x, p.y) < 700 * 700,
      );
      if (prey) return `cut in front of ${prey.name}: their head hits your body and they pop`;
    }
    if (t < 40) return "eat orbs to grow; never touch another snake with your head";
    return null;
  }

  /** Rough direction from the player (or camera) to a point. */
  private compass(x: number, y: number): string {
    const p = this.world.player ?? { x: this.cam.x, y: this.cam.y };
    const dx = x - p.x;
    const dy = y - p.y;
    const ns = Math.abs(dy) > Math.abs(dx) * 0.4 ? (dy < 0 ? "north" : "south") : "";
    const ew = Math.abs(dx) > Math.abs(dy) * 0.4 ? (dx < 0 ? "west" : "east") : "";
    return ns && ew ? `${ns}-${ew}` : ns || ew || "here";
  }

  private onNear(combo: number, bonus: number): void {
    this.near = { combo, bonus, t: performance.now() };
    this.audio.near(combo);
    const p = this.world.player;
    if (p) {
      this.floaters.push({
        x: p.x,
        y: p.y - radiusOf(p.mass) * 2,
        text: combo > 1 ? `close x${combo}` : "close!",
        life: 0.9,
        color: "#f0c14a",
      });
    }
  }

  /** Boost trails per cosmetic id, spawned behind the tail each tick. */
  private trailFx(dt: number): void {
    for (const s of this.world.snakes) {
      if (!s.boosting || !s.trail || !s.points.length) continue;
      const tail = s.points[0]!;
      const r = radiusOf(s.mass);
      // About 24 particles per second per snake, whatever the frame rate.
      if (Math.random() > 24 * dt) continue;
      const color =
        s.trail === 3
          ? `hsl(${(performance.now() / 4) % 360} 90% 60%)`
          : s.trail === 2
            ? "#ff8a3d"
            : s.trail === 4
              ? "#bfe9ff"
              : s.trail === 5
                ? "#6b3fd6"
                : "#ffffff";
      const a = Math.random() * Math.PI * 2;
      const sp = s.trail === 1 ? 90 : 30;
      this.particles.push({
        x: tail.x + Math.cos(a) * r * 0.5,
        y: tail.y + Math.sin(a) * r * 0.5,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.4 + Math.random() * 0.4,
        color,
        r: s.trail === 2 ? 3 + Math.random() * 3 : 1.5 + Math.random() * 2,
      });
    }
  }

  /** Rumble when a much bigger snake is near; heartbeat when boosting short. */
  private audioCues(): void {
    const p = this.world.player;
    if (!p || this.phase !== "play") {
      this.audio.setDanger(0);
      this.audio.setHeartbeat(false);
      return;
    }
    let danger = 0;
    for (const o of this.world.snakes) {
      if (o.id === p.id || o.mass < p.mass * 2) continue;
      const d = Math.sqrt(dist2(p.x, p.y, o.x, o.y));
      const range = 420 + radiusOf(o.mass) * 6;
      if (d < range) danger = Math.max(danger, 1 - d / range);
    }
    this.audio.setDanger(danger);
    // Heartbeat when a bigger head is within two of your lengths, or while
    // boosting a snake that is about to run out of length.
    const reach = 2 * lengthOf(p.mass);
    let stalked = false;
    for (const o of this.world.snakes) {
      if (o.id === p.id || !o.alive || o.mass < p.mass * 1.3) continue;
      if (dist2(p.x, p.y, o.x, o.y) < reach * reach) {
        stalked = true;
        break;
      }
    }
    this.audio.setHeartbeat(stalked || (p.boosting && p.mass < 30));
    const st = this.stats;
    if (st && st.rank > 0 && st.count > 1)
      this.audio.setIntensity(1 - (st.rank - 1) / (st.count - 1));
    this.audio.setMood(p.mass >= 1500 ? 2 : p.mass >= 200 ? 1 : 0);
  }

  private pushFeed(text: string): void {
    this.feed.push({ text, t: performance.now() });
    if (this.feed.length > 4) this.feed.shift();
  }

  private registerKill(victim: string): void {
    const now = performance.now();
    if (!this.firstKillDone) {
      this.firstKillDone = true;
      if (this.isFirstLife()) this.pushFeed("first blood! that is the whole game");
    }
    this.streak = now - this.lastKillAt < 7000 ? this.streak + 1 : 1;
    this.lastKillAt = now;
    this.kills++;
    this.audio.kill();
    // Hit stop: a camera punch and 250 ms of slowed effects with a slight
    // zoom-in, so a kill lands as a moment rather than a number ticking up.
    this.cam.trauma = Math.min(1, this.cam.trauma + 0.3);
    this.hitStopUntil = now + 250;
    this.killNotice =
      this.streak >= 4
        ? `rampage · ${this.streak} kills`
        : this.streak === 3
          ? `triple kill · ${victim}`
          : this.streak === 2
            ? `double kill · ${victim}`
            : `you took down ${victim}`;
    this.killTimer = 2.6;
  }

  /** Pop the body into orbs from head to tail over a few hundred ms. */
  private deathBurst(s: Snake): void {
    const color = fillOf(s);
    this.cam.trauma = Math.min(1, this.cam.trauma + (s.id === this.world.playerId ? 0.7 : 0.28));
    const r = radiusOf(s.mass);
    switch (s.deathFx) {
      case 1:
        // Ring: a fast expanding circle of sparks from the head.
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * Math.PI * 2;
          this.particles.push({
            x: s.x,
            y: s.y,
            vx: Math.cos(a) * (220 + r * 3),
            vy: Math.sin(a) * (220 + r * 3),
            life: 0.7,
            color: "#ffffff",
            r: 2.5,
          });
        }
        break;
      case 2:
        // Shatter: heavy shards in the skin colour.
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 80 + Math.random() * 260;
          this.particles.push({
            x: s.x,
            y: s.y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            life: 0.9 + Math.random() * 0.5,
            color,
            r: 3 + Math.random() * 5,
          });
        }
        break;
      case 3:
        // Nova: two rings, white then skin colour.
        for (const [ring, col, sp] of [
          [0, "#ffffff", 300],
          [1, color, 180],
        ] as const) {
          for (let i = 0; i < 36; i++) {
            const a = (i / 36) * Math.PI * 2 + ring * 0.09;
            this.particles.push({
              x: s.x,
              y: s.y,
              vx: Math.cos(a) * sp,
              vy: Math.sin(a) * sp,
              life: 0.8,
              color: col,
              r: 3,
            });
          }
        }
        break;
      case 4:
        // Confetti: many small bright flecks in random colours.
        for (let i = 0; i < 60; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 60 + Math.random() * 300;
          this.particles.push({
            x: s.x,
            y: s.y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp - 60,
            life: 1 + Math.random() * 0.8,
            color: `hsl(${Math.floor(Math.random() * 360)} 90% 60%)`,
            r: 2 + Math.random() * 2.5,
          });
        }
        break;
      default:
        break;
    }
    const pts = s.points.length ? s.points.slice().reverse() : [{ x: s.x, y: s.y }];
    const fx: DeathFx = {
      pts,
      color,
      t: 0,
      dur: Math.min(0.9, 0.25 + pts.length * 0.008),
      next: 0,
    };
    if (s.id === this.world.playerId) this.deathFx = fx;
    else this.deathFxList.push(fx);
  }

  private deathFxList: DeathFx[] = [];

  private stepDeathFx(dt: number): void {
    const list = this.deathFx ? [this.deathFx, ...this.deathFxList] : this.deathFxList;
    for (const fx of list) {
      fx.t += dt;
      const upto = Math.min(fx.pts.length, Math.floor((fx.t / fx.dur) * fx.pts.length));
      for (; fx.next < upto; fx.next++) {
        const p = fx.pts[fx.next]!;
        if (fx.next % 2 === 0) this.burst(p.x, p.y, fx.color, 5, 120);
      }
    }
    this.deathFxList = this.deathFxList.filter((f) => f.t < f.dur + 0.2);
    if (this.deathFx && this.deathFx.t > this.deathFx.dur + 0.2) this.deathFx = null;
  }

  private dieLocal(
    reason: "wall" | "snake",
    killerName: string | null,
    killerId: string | null,
    why?: string,
  ): void {
    this.audio.death();
    const p = this.world.player;
    this.deathMass = p?.mass ?? this.deathMass;
    {
      const h = this.hud();
      this.deathRank = h.rank;
      this.deathCount = h.count;
    }
    this.deathCam = { x: p?.x ?? this.cam.x, y: p?.y ?? this.cam.y };
    this.corpse = p ? { ...p, points: p.points.map((q) => ({ ...q })) } : null;
    {
      const score = Math.floor(this.deathMass);
      const best = this.profile?.best ?? this.best;
      if (best > 30 && score >= best * 0.85 && score < best)
        this.nearWin = `${best - score} short of your best`;
      else if (this.deathRank > 1 && this.deathRank <= 3)
        this.nearWin = `${this.deathRank - 1} rank${this.deathRank === 2 ? "" : "s"} from the top`;
      else this.nearWin = null;
    }
    // The server's first WISP message can arrive before or after DEATH, so
    // only flag the wish here; the wisp state itself resets on spawn.
    this.wispWanted = this.online;
    this.phase = "dead";
    this.boosting = false;
    this.holdBoost = false;
    this.spawnWait = 0;
    this.deathBeatUntil = performance.now() + 700;
    this.respawnArmedAt = this.deathBeatUntil + 300;
    this.replayFrozen = this.replayBuf.length ? this.replayBuf.slice() : null;
    try {
      localStorage.setItem("agencoil-played", "1");
    } catch {
      /* ignore */
    }
    this.net?.idle();
    this.deathReason =
      why ??
      (reason === "wall"
        ? "you hit the rim"
        : killerName
          ? `you ran into ${killerName}`
          : "you crashed");
    this.killerName = killerName;
    this.killerId = killerId;
    if (this.local && this.local.playerId) {
      this.local.playerId = null;
    }
    this.emitHud();
  }

  private updateCam(dt: number): void {
    const world = this.world;
    if (this.phase === "menu") {
      // Spectate the current leader while online; drift around the centre
      // otherwise.
      const top = this.online ? this.stats?.board[0] : undefined;
      const live = top ? world.snakes.find((s) => s.id === String(top.nid)) : undefined;
      const target = live ?? top;
      if (target) {
        this.cam.x = lerp(this.cam.x, target.x, 1 - Math.pow(0.01, dt));
        this.cam.y = lerp(this.cam.y, target.y, 1 - Math.pow(0.01, dt));
      } else {
        this.menuT += dt * 0.12;
        this.cam.x = Math.cos(this.menuT) * 420;
        this.cam.y = Math.sin(this.menuT * 0.7) * 320;
      }
    } else if (this.phase === "wisp" && this.wisp) {
      // Ease onto the wisp, then sit on it: a lagging camera drew the wisp
      // 45 to 70 units ahead of centre, so a cursor resting near centre was
      // behind it and turned it around every frame.
      const easing = performance.now() - this.wispStartedAt < WISP_CAM_EASE_MS;
      const k = easing ? 1 - Math.pow(0.0008, dt) : 1;
      this.cam.x = lerp(this.cam.x, this.wisp.x, k);
      this.cam.y = lerp(this.cam.y, this.wisp.y, k);
    } else if (this.phase === "dead") {
      let target: Vec | null = null;
      if (this.watchNid !== null) {
        const live = world.snakes.find((s) => s.id === String(this.watchNid));
        const listed = this.stats?.board.find((b) => b.nid === this.watchNid);
        target = live ?? listed ?? null;
      }
      if (!target) {
        const killer = this.killerId ? world.snakes.find((s) => s.id === this.killerId) : null;
        target = killer ?? this.corpse;
      }
      if (target) {
        this.deathCam.x = lerp(this.deathCam.x, target.x, 1 - Math.pow(0.04, dt));
        this.deathCam.y = lerp(this.deathCam.y, target.y, 1 - Math.pow(0.04, dt));
      }
      this.cam.x = lerp(this.cam.x, this.deathCam.x, 1 - Math.pow(0.001, dt));
      this.cam.y = lerp(this.cam.y, this.deathCam.y, 1 - Math.pow(0.001, dt));
    } else {
      const p = world.player;
      if (p) {
        // The camera sits on the head, as in slither.io.
        this.cam.x = lerp(this.cam.x, p.x, 1 - Math.pow(0.0008, dt));
        this.cam.y = lerp(this.cam.y, p.y, 1 - Math.pow(0.0008, dt));
      }
    }
    const mass = world.player?.mass ?? this.deathMass;
    let z = this.phase === "wisp" ? desiredZoom(40, "play") * 1.05 : desiredZoom(mass, this.phase);
    if (this.phase === "dead" && performance.now() < this.deathBeatUntil) z *= 1.25;
    if (this.phase === "play") {
      z *= this.zoomMul;
      if (world.player?.boosting) z *= 0.965;
      if (performance.now() < this.hitStopUntil) z *= 1.05;
    }
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
      this.world,
      this.particles,
      this.floaters,
      this.world.playerId,
      this.phase,
      this.phase === "play" ? this.pointer : null,
      this.insets,
      this.event && this.event.left - (performance.now() - this.event.at) / 1000 > 0
        ? { x: this.event.x, y: this.event.y }
        : null,
      this.profile && this.profile.best > 0 && (this.profile.bestX || this.profile.bestY)
        ? { x: this.profile.bestX, y: this.profile.bestY, best: this.profile.best }
        : null,
      this.emotes,
      this.phase === "wisp" ? this.wisp : null,
    );
    const nowMs = performance.now();
    for (const [id, e] of this.emotes) if (e.until < nowMs) this.emotes.delete(id);
    if (this.stick && this.phase === "play") {
      const rect = this.canvas.getBoundingClientRect();
      this.renderer.drawStick(this.ctx, this.dpr, {
        ox: this.stick.ox - rect.left,
        oy: this.stick.oy - rect.top,
        x: this.stick.x - rect.left,
        y: this.stick.y - rect.top,
      });
    }
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
    const world = this.world;
    const p = world.player;
    let pts = 0;
    for (const s of world.snakes) if (s.points.length > pts) pts = s.points.length;
    (window as unknown as { __coil?: unknown }).__coil = {
      phase: this.phase,
      mode: this.net?.state ?? "offline",
      instance: this.net?.instance ?? "",
      rtt: this.net?.rttMs ?? 0,
      eatMisses: this.net?.eatMisses ?? 0,
      boosting: this.boosting,
      controls: this.controls,
      diag: this.net?.diag ?? null,
      interpMs: this.net?.delayMs ?? 0,
      score: p ? Math.floor(p.mass) : 0,
      headX: p ? Math.round(p.x) : 0,
      headY: p ? Math.round(p.y) : 0,
      angle: p ? Math.round(p.angle * 1000) / 1000 : 0,
      playerPts: p?.points.length ?? 0,
      snakes: world.snakes.length,
      foods: world.foods.length,
      pts,
      kills: this.kills,
      players: this.stats?.clients ?? 0,
      replayFrames: (this.replayFrozen ?? this.replayBuf).length,
      replaySnakes: (this.replayFrozen ?? this.replayBuf).at(-1)?.snakes.length ?? -1,
      deathsWall: this.dbgWall,
      deathsSnake: this.dbgSnake,
      fps: Math.round(this.fps),
    };
  }
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
