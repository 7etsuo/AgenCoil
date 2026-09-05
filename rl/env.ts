/**
 * A reinforcement-learning environment over the real arena. Nothing here
 * changes the game: the world is the same `World` the server runs, with the
 * same bots, and the learner's snakes are ordinary player snakes with an
 * entry in `inputs`. What the learner sees is a coarse egocentric polar map
 * of bodies, heads, food and the rim around its head, plus a few numbers
 * about itself and the nearest heads; what it does is pick a heading change
 * and whether to boost, ten times a second. The reward is length gained,
 * a bonus per kill, and the whole length lost at death, so the learner is
 * paid for exactly what the game pays for. Every life, the learner's and
 * the bots', is reported with the numbers the analysis needs: how long it
 * lasted, how it ended, how much of it was spent boosting or at the rim.
 */
import {
  ARENA_RADIUS,
  BOOST_MIN_MASS,
  lengthOf,
  radiusOf,
  wrapAngle,
  type Snake,
} from "../src/game/model";
import { World, type DeathEvent } from "../src/game/world";

/** Ring edges as fractions of the reach; the reach grows with the snake, like the camera. */
export const RING_EDGES = [0.12, 0.25, 0.4, 0.6, 0.8, 1] as const;
export const RINGS = RING_EDGES.length;
export const SECTORS = 16;
/** Per cell: a foreign body, a foreign head, that head's size against ours, food, the rim. */
export const CHANNELS = 5;
export const K_HEADS = 3;
export const HEAD_DIM = 6;
export const SELF_DIM = 9;
export const GRID_DIM = RINGS * SECTORS * CHANNELS;
export const OBS_DIM = GRID_DIM + SELF_DIM + K_HEADS * HEAD_DIM;
/** Heading changes on offer, in radians; each comes with and without boost. */
export const TURNS = [-90, -60, -30, -15, 0, 15, 30, 60, 90].map((d) => (d * Math.PI) / 180);
export const N_ACTIONS = TURNS.length * 2;
/** Simulation ticks per decision: 4 at 40 Hz is ten decisions a second. */
export const DECISION_TICKS = 4;
const DT = 1 / 40;
/** Inside this many units of the rim counts as "at the rim" for the report. */
const RIM_BAND = 900;
const MASS_SCALE = 0.01;
const DEATH_PENALTY = 2;
const KILL_BONUS = 2;

/** One finished life, the learner's or a bot's. */
export interface LifeStats {
  agent: boolean;
  secs: number;
  mass: number;
  maxMass: number;
  kills: number;
  /** wall, bot, agent, headon (the killer died too) or other. */
  cause: string;
  boostFrac: number;
  rimFrac: number;
  remains: number;
  food: number;
  nears: number;
  /** Where it died, as a fraction of the arena radius (1 is the rim). */
  deathRadius: number;
  /** The killer's length at the time, 0 for the rim or nobody. */
  killerMass: number;
  /** How old the arena was at the end, in seconds since its bots were seeded. */
  arenaSecs: number;
}

export interface StepResult {
  obs: Float32Array;
  rewards: Float32Array;
  dones: Uint8Array;
  ended: LifeStats[];
}

export interface ArenaOptions {
  agents: number;
  bots?: number;
  /**
   * Rebuild the world after this many decisions (0 never): the bots of an
   * arena nobody hunts grow into giants over an hour, and the learner should
   * see young arenas as well as old ones. Lives cut short by a reset are
   * reported with cause "reset".
   */
  resetEvery?: number;
  /** The first reset comes sooner by this many decisions, so arenas do not all reset together. */
  resetOffset?: number;
}

interface AgentState {
  id: string;
  slot: number;
  snake: Snake;
  startTick: number;
  steps: number;
  boostSteps: number;
  rimSteps: number;
  remains: number;
  food: number;
  nears: number;
  maxMass: number;
  massPrev: number;
  killsPending: number;
  death: DeathEvent | null;
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

/** How far the learner sees: about what a player's screen shows at that size. */
export function reachOf(mass: number): number {
  return 520 + 20 * radiusOf(mass);
}

export class Arena {
  world = new World(true);
  private agents: AgentState[] = [];
  private byId = new Map<string, AgentState>();
  /** When each live bot was first seen, for its life length. */
  private botBorn = new Map<string, number>();
  private tick = 0;
  private arenaBorn = 0;
  private nextId = 1;
  private decisions = 0;
  private readonly bots: number;
  private readonly resetEvery: number;
  private nextReset: number;

  constructor(opts: ArenaOptions) {
    this.bots = opts.bots ?? 50;
    this.resetEvery = opts.resetEvery ?? 0;
    this.nextReset = this.resetEvery ? Math.max(1, this.resetEvery - (opts.resetOffset ?? 0)) : 0;
    this.build(opts.agents);
  }

  /** A fresh world with fresh bots and fresh learners. */
  private build(nAgents: number): void {
    this.arenaBorn = this.tick;
    this.world = new World(true);
    this.world.host = true;
    this.world.resetLocalBots(this.bots);
    this.agents = [];
    this.byId = new Map();
    this.botBorn = new Map();
    for (let i = 0; i < nAgents; i++) this.agents.push(this.spawn(i));
    this.noteBots();
  }

  get size(): number {
    return this.agents.length;
  }

  private spawn(slot: number): AgentState {
    const id = `a${this.nextId++}`;
    const snake = this.world.spawnSnake(id, `agent${slot}`, slot % 16, false);
    this.world.inputs.set(id, { angle: snake.angle, boost: false });
    this.world.nearIds.add(id);
    const a: AgentState = {
      id,
      slot,
      snake,
      startTick: this.tick,
      steps: 0,
      boostSteps: 0,
      rimSteps: 0,
      remains: 0,
      food: 0,
      nears: 0,
      maxMass: snake.mass,
      massPrev: snake.mass,
      killsPending: 0,
      death: null,
    };
    this.byId.set(id, a);
    return a;
  }

  private noteBots(): void {
    for (const s of this.world.snakes)
      if (s.isBot && s.alive && !this.botBorn.has(s.id)) this.botBorn.set(s.id, this.tick);
  }

  reset(): Float32Array {
    const obs = new Float32Array(this.agents.length * OBS_DIM);
    for (let i = 0; i < this.agents.length; i++) this.encode(this.agents[i]!, obs, i * OBS_DIM);
    return obs;
  }

  step(actions: ArrayLike<number>): StepResult {
    this.decisions++;
    if (this.resetEvery && this.decisions >= this.nextReset) {
      this.nextReset = this.decisions + this.resetEvery;
      return this.resetWorld();
    }
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i]!;
      const action = actions[i] ?? 4;
      const turn = TURNS[action % TURNS.length]!;
      const input = this.world.inputs.get(a.id);
      if (input) {
        input.angle = wrapAngle(a.snake.angle + turn);
        input.boost = action >= TURNS.length;
      }
    }
    const ended: LifeStats[] = [];
    for (let t = 0; t < DECISION_TICKS; t++) {
      this.world.step(DT, 0, 0, false);
      this.tick++;
      if (this.world.deaths.length) this.onDeaths(this.world.deaths, ended);
      for (const e of this.world.eats) {
        const a = this.byId.get(e.id);
        if (!a) continue;
        if (e.k === 2) a.remains += e.v;
        else a.food += e.v;
      }
      for (const n of this.world.nears) {
        const a = this.byId.get(n.id);
        if (a) a.nears++;
      }
    }
    this.noteBots();
    const n = this.agents.length;
    const obs = new Float32Array(n * OBS_DIM);
    const rewards = new Float32Array(n);
    const dones = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.agents[i]!;
      let r = KILL_BONUS * a.killsPending;
      if (a.death) {
        r -= MASS_SCALE * a.massPrev + DEATH_PENALTY;
        dones[i] = 1;
        this.byId.delete(a.id);
        this.world.inputs.delete(a.id);
        this.world.nearIds.delete(a.id);
        this.agents[i] = this.spawn(a.slot);
      } else {
        const s = a.snake;
        r += MASS_SCALE * (s.mass - a.massPrev);
        a.massPrev = s.mass;
        a.steps++;
        if (s.boosting) a.boostSteps++;
        if (Math.hypot(s.x, s.y) > ARENA_RADIUS - RIM_BAND) a.rimSteps++;
        if (s.mass > a.maxMass) a.maxMass = s.mass;
      }
      rewards[i] = r;
      this.encode(this.agents[i]!, obs, i * OBS_DIM);
    }
    return { obs, rewards, dones, ended };
  }

  /** End every learner's life with cause "reset" and start over in a new world. */
  private resetWorld(): StepResult {
    const n = this.agents.length;
    const ended: LifeStats[] = [];
    for (const a of this.agents) {
      const steps = Math.max(1, a.steps);
      ended.push({
        agent: true,
        secs: (this.tick - a.startTick) * DT,
        mass: a.snake.mass,
        maxMass: a.maxMass,
        kills: a.snake.kills,
        cause: "reset",
        boostFrac: a.boostSteps / steps,
        rimFrac: a.rimSteps / steps,
        remains: a.remains,
        food: a.food,
        nears: a.nears,
        deathRadius: Math.hypot(a.snake.x, a.snake.y) / ARENA_RADIUS,
        killerMass: 0,
        arenaSecs: (this.tick - this.arenaBorn) * DT,
      });
    }
    this.build(n);
    const obs = new Float32Array(n * OBS_DIM);
    for (let i = 0; i < n; i++) this.encode(this.agents[i]!, obs, i * OBS_DIM);
    const dones = new Uint8Array(n);
    dones.fill(1);
    return { obs, rewards: new Float32Array(n), dones, ended };
  }

  private onDeaths(deaths: DeathEvent[], ended: LifeStats[]): void {
    const dead = new Set(deaths.map((d) => d.snake.id));
    for (const d of deaths) {
      const s = d.snake;
      const cause =
        d.reason === "wall"
          ? "wall"
          : !d.killerId
            ? "other"
            : dead.has(d.killerId)
              ? "headon"
              : this.byId.has(d.killerId)
                ? "agent"
                : "bot";
      let killerMass = 0;
      if (d.killerId) {
        const killer = this.byId.get(d.killerId);
        if (killer) killer.killsPending++;
        const k = this.world.snakes.find((x) => x.id === d.killerId);
        if (k) killerMass = k.mass;
      }
      const deathRadius = Math.hypot(s.x, s.y) / ARENA_RADIUS;
      const a = this.byId.get(s.id);
      if (a) {
        a.death = d;
        const steps = Math.max(1, a.steps);
        ended.push({
          agent: true,
          secs: (this.tick - a.startTick) * DT,
          mass: s.mass,
          maxMass: Math.max(a.maxMass, s.mass),
          kills: s.kills,
          cause,
          boostFrac: a.boostSteps / steps,
          rimFrac: a.rimSteps / steps,
          remains: a.remains,
          food: a.food,
          nears: a.nears,
          deathRadius,
          killerMass,
          arenaSecs: (this.tick - this.arenaBorn) * DT,
        });
      } else if (s.isBot) {
        const born = this.botBorn.get(s.id) ?? this.tick;
        this.botBorn.delete(s.id);
        ended.push({
          agent: false,
          secs: (this.tick - born) * DT,
          mass: s.mass,
          maxMass: s.mass,
          kills: s.kills,
          cause,
          boostFrac: 0,
          rimFrac: 0,
          remains: 0,
          food: 0,
          nears: 0,
          deathRadius,
          killerMass,
          arenaSecs: (this.tick - this.arenaBorn) * DT,
        });
      }
    }
  }

  private encode(a: AgentState, out: Float32Array, base: number): void {
    encodeObservation(this.world, a.snake, out, base);
  }
}

/**
 * What the learner sees: an egocentric polar grid of `RINGS` by `SECTORS`
 * cells (sector 0 is straight ahead, going clockwise) with five channels,
 * then itself, then the nearest heads. Also used to drive the browser
 * client with a trained policy, where `world` is the client's mirror.
 */
export function encodeObservation(world: World, s: Snake, out: Float32Array, base: number): void {
  const R = reachOf(s.mass);
  const inv = 1 / R;
  const c = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  out.fill(0, base, base + OBS_DIM);
  // World offset to a cell index (times CHANNELS), or -1 outside the reach.
  const cell = (dx: number, dy: number): number => {
    const ex = dx * c + dy * sn;
    const ey = -dx * sn + dy * c;
    const d = Math.hypot(ex, ey) * inv;
    if (d > 1) return -1;
    let ring = 0;
    while (ring < RINGS - 1 && d > RING_EDGES[ring]!) ring++;
    const ang = Math.atan2(ey, ex);
    const sector =
      ((Math.floor(((ang + Math.PI) / (2 * Math.PI)) * SECTORS) % SECTORS) + SECTORS) % SECTORS;
    return base + (ring * SECTORS + sector) * CHANNELS;
  };
  const heads: { d: number; o: Snake }[] = [];
  for (const o of world.snakes) {
    if (o === s || !o.alive) continue;
    const box = o.box;
    if (box) {
      if (box.maxX < s.x - R || box.minX > s.x + R || box.maxY < s.y - R || box.minY > s.y + R)
        continue;
    } else {
      const reach = R + lengthOf(o.mass);
      if (Math.hypot(o.x - s.x, o.y - s.y) > reach) continue;
    }
    const pts = o.points;
    for (let i = 0; i < pts.length; i += 2) {
      const p = pts[i]!;
      const k = cell(p.x - s.x, p.y - s.y);
      if (k >= 0) out[k] = 1;
    }
    const hd = Math.hypot(o.x - s.x, o.y - s.y);
    const k = cell(o.x - s.x, o.y - s.y);
    if (k >= 0) {
      out[k] = 1;
      out[k + 1] = 1;
      const ratio = clamp(Math.log2(o.mass / s.mass) / 4, -1, 1);
      if (Math.abs(ratio) > Math.abs(out[k + 2]!)) out[k + 2] = ratio;
    }
    if (hd <= R) heads.push({ d: hd, o });
  }
  world.forEachFoodIn(s.x - R, s.y - R, s.x + R, s.y + R, (f) => {
    const k = cell(f.x - s.x, f.y - s.y);
    if (k >= 0) out[k + 3] = Math.min(1, out[k + 3]! + f.v * 0.05);
  });
  // The rim, where a cell's centre lies outside the arena.
  let prev = 0;
  for (let ri = 0; ri < RINGS; ri++) {
    const mid = ((prev + RING_EDGES[ri]!) / 2) * R;
    prev = RING_EDGES[ri]!;
    for (let si = 0; si < SECTORS; si++) {
      const ego = -Math.PI + ((si + 0.5) / SECTORS) * Math.PI * 2;
      const w = s.angle + ego;
      const px = s.x + Math.cos(w) * mid;
      const py = s.y + Math.sin(w) * mid;
      if (px * px + py * py > ARENA_RADIUS * ARENA_RADIUS)
        out[base + (ri * SECTORS + si) * CHANNELS + 4] = 1;
    }
  }
  let b = base + GRID_DIM;
  out[b++] = Math.log(s.mass) / 10;
  out[b++] = radiusOf(s.mass) / 70;
  out[b++] = s.boosting ? 1 : 0;
  out[b++] = s.invuln > 0 ? 1 : 0;
  out[b++] = clamp((ARENA_RADIUS - Math.hypot(s.x, s.y)) / 2000, 0, 1);
  const toCentre = Math.atan2(-s.y, -s.x) - s.angle;
  out[b++] = Math.cos(toCentre);
  out[b++] = Math.sin(toCentre);
  out[b++] = s.mass > BOOST_MIN_MASS + 5 ? 1 : 0;
  out[b++] = clamp(lengthOf(s.mass) / 3000, 0, 1);
  heads.sort((p, q) => p.d - q.d);
  for (let k = 0; k < K_HEADS && k < heads.length; k++) {
    const o = heads[k]!.o;
    const dx = o.x - s.x;
    const dy = o.y - s.y;
    const ex = dx * c + dy * sn;
    const ey = -dx * sn + dy * c;
    const rel = o.angle - s.angle;
    const at = base + GRID_DIM + SELF_DIM + k * HEAD_DIM;
    out[at] = ex * inv;
    out[at + 1] = ey * inv;
    out[at + 2] = Math.cos(rel);
    out[at + 3] = Math.sin(rel);
    out[at + 4] = clamp(Math.log2(o.mass / s.mass) / 4, -1, 1);
    out[at + 5] = o.boosting ? 1 : 0;
  }
}
