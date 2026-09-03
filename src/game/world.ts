import {
  ARENA_RADIUS,
  BASE_SPEED,
  BOOST_DROP_EVERY,
  BOOST_SPEED,
  BOT_RESPAWN_DELAY,
  CHASE_COLOR,
  CHASE_ORBS,
  FOOD_COLORS,
  FOOD_TARGET,
  MAGNET_SPEED,
  MIN_MASS,
  SPAWN_INVULN,
  START_MASS,
  type Food,
  type Snake,
  type Vec,
  boostDrainOf,
  clamp,
  dist2,
  lengthOf,
  maxPointsOf,
  pickBotName,
  pointSegDist2,
  radiusOf,
  randRange,
  randomInDisk,
  spacingOf,
  turnRateOf,
  wrapAngle,
} from "./model";

export const CELL = 96;
const GRID_OFF = 256;
const GRID_SPAN = 512;
const CHASE_SPEED = 215;
const CHASE_SENSE = 320;

export interface EatEvent {
  x: number;
  y: number;
  v: number;
  c: number;
  id: string;
}

export interface DeathEvent {
  snake: Snake;
  reason: "wall" | "snake";
  killerId: string | null;
  killerName: string | null;
  pellets: Food[];
}

/** What a networked player wants this tick. */
export interface PlayerInput {
  angle: number;
  boost: boolean;
}

export function cellKey(x: number, y: number): number {
  const gx = Math.floor(x / CELL) + GRID_OFF;
  const gy = Math.floor(y / CELL) + GRID_OFF;
  return gx * GRID_SPAN + gy;
}

/**
 * The arena. Three ways to use it:
 *  - offline: `playerId` is steered by aim, bots run when `host` is true;
 *  - server: every player has an entry in `inputs`, bots run, all collisions
 *    are judged here;
 *  - client mirror: no stepping at all, just the entity store, the food grid,
 *    and the trail helpers the network layer uses to grow bodies.
 */
export class World {
  snakes: Snake[] = [];
  foods: Food[] = [];
  playerId: string | null = null;
  host = true;
  /** How many bots this world should keep alive (0 when not host). */
  desiredBots = 0;
  inputs = new Map<string, PlayerInput>();
  eats: EatEvent[] = [];
  deaths: DeathEvent[] = [];
  foodById = new Map<number, Food>();
  private grid = new Map<number, Food[]>();
  private foodIndex = new Map<Food, number>();
  private chasers: Food[] = [];
  private botTimer = 0;
  private nextFoodId = 1;
  private nextBotId = 1;

  constructor(fill = true) {
    if (fill) this.fillFood(FOOD_TARGET);
  }

  get player(): Snake | undefined {
    return this.snakes.find((s) => s.id === this.playerId);
  }

  resetLocalBots(n: number): void {
    this.snakes = this.snakes.filter((s) => !s.isBot);
    const used = new Set(this.snakes.map((s) => s.name.toLowerCase()));
    for (let i = 0; i < n; i++) this.spawnBot(used);
    this.desiredBots = n;
    this.botTimer = 0;
  }

  clearBots(): void {
    this.snakes = this.snakes.filter((s) => !s.isBot);
  }

  spawnPlayer(id: string, name: string, skin: number, bands?: string[]): Snake {
    const s = this.spawnSnake(id, name, skin, false, bands);
    this.playerId = id;
    return s;
  }

  /** Spawn (or respawn) a snake without touching `playerId`. */
  spawnSnake(
    id: string,
    name: string,
    skin: number,
    isBot: boolean,
    bands?: string[],
    mass?: number,
  ): Snake {
    this.snakes = this.snakes.filter((s) => s.id !== id);
    const s = this.makeSnake(id, name, skin, isBot);
    if (bands && bands.length) s.bands = bands.slice(0, 6);
    if (mass && mass > START_MASS) {
      s.mass = mass;
      s.points = [];
      this.ensureTrail(s);
    }
    this.snakes.push(s);
    return s;
  }

  spawnBot(used: Set<string>): Snake {
    const name = pickBotName(used);
    used.add(name.toLowerCase());
    const s = this.makeSnake(`b${this.nextBotId++}`, name, (Math.random() * 16) | 0, true);
    const roll = Math.random();
    s.mass = START_MASS + Math.random() * 40;
    if (roll < 0.35) s.mass += 60 + Math.random() * 160;
    if (roll < 0.1) s.mass += 300 + Math.random() * 700;
    s.temper = Math.random();
    s.points = [];
    this.ensureTrail(s);
    this.snakes.push(s);
    return s;
  }

  makeSnake(id: string, name: string, skin: number, isBot: boolean): Snake {
    const pos = this.findSpawn();
    const angle = Math.random() * Math.PI * 2;
    const s: Snake = {
      id,
      name,
      skin: skin % 16,
      x: pos.x,
      y: pos.y,
      angle,
      mass: START_MASS,
      boosting: false,
      points: [],
      alive: true,
      isBot,
      invuln: SPAWN_INVULN,
      wander: angle,
      think: Math.random() * 0.3,
      avoid: 0,
      avoidDir: 1,
      boostLeft: 0,
      dropped: 0,
      temper: 0.5,
      kills: 0,
    };
    this.ensureTrail(s);
    return s;
  }

  removeSnake(id: string, drop = false): void {
    const s = this.snakes.find((x) => x.id === id);
    if (!s) return;
    if (drop && s.alive) this.kill(s, "snake", null, null);
    this.snakes = this.snakes.filter((x) => x.id !== id);
    this.inputs.delete(id);
  }

  upsertRemote(s: Snake): void {
    const i = this.snakes.findIndex((x) => x.id === s.id);
    if (i >= 0) this.snakes[i] = s;
    else this.snakes.push(s);
  }

  // ── food store ─────────────────────────────────────────────────────────────

  addFood(f: Food): Food {
    if (f.id === undefined) f.id = this.nextFoodId++;
    else if (f.id >= this.nextFoodId) this.nextFoodId = f.id + 1;
    this.foodById.set(f.id, f);
    this.foodIndex.set(f, this.foods.length);
    this.foods.push(f);
    const key = cellKey(f.x, f.y);
    const bucket = this.grid.get(key);
    if (bucket) bucket.push(f);
    else this.grid.set(key, [f]);
    if (f.k === 3) this.chasers.push(f);
    return f;
  }

  removeFood(f: Food): void {
    const idx = this.foodIndex.get(f);
    if (idx === undefined) return;
    const last = this.foods.length - 1;
    const moved = this.foods[last]!;
    this.foods[idx] = moved;
    this.foodIndex.set(moved, idx);
    this.foods.pop();
    this.foodIndex.delete(f);
    if (f.id !== undefined) this.foodById.delete(f.id);
    this.unbucket(f);
    if (f.k === 3) {
      const ci = this.chasers.indexOf(f);
      if (ci >= 0) this.chasers.splice(ci, 1);
    }
  }

  removeFoodById(id: number): void {
    const f = this.foodById.get(id);
    if (f) this.removeFood(f);
  }

  clearFood(): void {
    this.foods = [];
    this.foodById.clear();
    this.foodIndex.clear();
    this.grid.clear();
    this.chasers = [];
  }

  private unbucket(f: Food): void {
    const key = cellKey(f.x, f.y);
    const bucket = this.grid.get(key);
    if (!bucket) return;
    const i = bucket.indexOf(f);
    if (i >= 0) {
      bucket[i] = bucket[bucket.length - 1]!;
      bucket.pop();
    }
    if (!bucket.length) this.grid.delete(key);
  }

  moveFood(f: Food, x: number, y: number): void {
    const before = cellKey(f.x, f.y);
    const after = cellKey(x, y);
    if (before === after) {
      f.x = x;
      f.y = y;
      return;
    }
    this.unbucket(f);
    f.x = x;
    f.y = y;
    const bucket = this.grid.get(after);
    if (bucket) bucket.push(f);
    else this.grid.set(after, [f]);
  }

  /** Visit every orb whose cell overlaps the rectangle. */
  forEachFoodIn(x0: number, y0: number, x1: number, y1: number, fn: (f: Food) => void): void {
    const gx0 = Math.floor(x0 / CELL);
    const gx1 = Math.floor(x1 / CELL);
    const gy0 = Math.floor(y0 / CELL);
    const gy1 = Math.floor(y1 / CELL);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const bucket = this.grid.get((gx + GRID_OFF) * GRID_SPAN + (gy + GRID_OFF));
        if (!bucket) continue;
        for (const f of bucket) fn(f);
      }
    }
  }

  queryFood(x: number, y: number, r: number): Food[] {
    const out: Food[] = [];
    this.forEachFoodIn(x - r, y - r, x + r, y + r, (f) => out.push(f));
    return out;
  }

  get chaseOrbs(): readonly Food[] {
    return this.chasers;
  }

  /** The glowing remains a snake leaves behind: worth most of its mass. */
  pelletsFrom(s: Snake): Food[] {
    const out: Food[] = [];
    const n = Math.round(clamp(8 + s.mass * 0.3, 8, 150));
    const each = Math.max(1, (s.mass * 0.72) / n);
    const pts = s.points.length ? s.points : [{ x: s.x, y: s.y }];
    for (let i = 0; i < n; i++) {
      const p = pts[((i / n) * (pts.length - 1)) | 0]!;
      const v = Math.round(each * randRange(0.7, 1.3) * 10) / 10;
      out.push({
        x: p.x + randRange(-9, 9),
        y: p.y + randRange(-9, 9),
        v,
        c: this.skinFoodColor(s.skin),
        r: clamp(6 + Math.sqrt(v) * 2.4, 6, 17),
        k: 2,
      });
    }
    return out;
  }

  private skinFoodColor(skin: number): number {
    return skin % FOOD_COLORS.length;
  }

  // ── simulation ─────────────────────────────────────────────────────────────

  step(dt: number, aimX: number, aimY: number, wantBoost: boolean): void {
    this.deaths = [];
    this.eats = [];
    this.maintainFood();
    this.maintainBots(dt);

    for (const s of this.snakes) {
      if (!s.alive) continue;
      const input = this.inputs.get(s.id);
      if (input) {
        this.steerHeading(s, input.angle, dt);
        s.boosting = input.boost && s.mass > MIN_MASS + 0.4;
        this.advance(s, dt);
      } else if (s.id === this.playerId) {
        this.steerToward(s, aimX, aimY, dt);
        s.boosting = wantBoost && s.mass > MIN_MASS + 0.4;
        this.advance(s, dt);
      } else if (s.isBot && this.host) {
        this.thinkBot(s, dt);
        this.advance(s, dt);
      }
    }

    this.magnet(dt);
    this.moveChasers(dt);
    this.resolveEats();
    this.resolveKills();
    this.cullDead();
  }

  private owned(s: Snake): boolean {
    return this.inputs.has(s.id) || s.id === this.playerId || (s.isBot && this.host);
  }

  private findSpawn(near?: Vec): Vec {
    for (let n = 0; n < 24; n++) {
      const p =
        near && n < 8
          ? { x: near.x + randRange(-300, 300), y: near.y + randRange(-300, 300) }
          : randomInDisk(ARENA_RADIUS * 0.8);
      if (p.x * p.x + p.y * p.y > (ARENA_RADIUS * 0.85) ** 2) continue;
      let ok = true;
      for (const s of this.snakes) {
        if (!s.alive) continue;
        const keep = 260 + radiusOf(s.mass) * 4;
        if (dist2(p.x, p.y, s.x, s.y) < keep * keep) {
          ok = false;
          break;
        }
        const stride = Math.max(1, (s.points.length / 20) | 0);
        for (let i = 0; i < s.points.length; i += stride) {
          const q = s.points[i]!;
          if (dist2(p.x, p.y, q.x, q.y) < 180 * 180) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
      if (ok) return p;
    }
    return randomInDisk(ARENA_RADIUS * 0.5);
  }

  /** A safe spawn point near a location, for players hopping instances. */
  safeSpawnNear(near: Vec): Vec {
    return this.findSpawn(near);
  }

  /** Lay a straight body behind the head. The last point is the head itself. */
  ensureTrail(s: Snake): void {
    if (s.points.length) return;
    const sp = spacingOf(s.mass);
    const n = Math.max(8, Math.round(lengthOf(s.mass) / sp));
    for (let i = n; i >= 1; i--) {
      s.points.push({
        x: s.x - Math.cos(s.angle) * sp * i,
        y: s.y - Math.sin(s.angle) * sp * i,
      });
    }
    s.points.push({ x: s.x, y: s.y });
  }

  steerToward(s: Snake, tx: number, ty: number, dt: number): void {
    const desired = Math.atan2(ty - s.y, tx - s.x);
    this.steerHeading(s, desired, dt);
  }

  steerHeading(s: Snake, desired: number, dt: number): void {
    const maxTurn = turnRateOf(s.mass) * dt;
    const delta = wrapAngle(desired - s.angle);
    s.angle = wrapAngle(s.angle + clamp(delta, -maxTurn, maxTurn));
  }

  /**
   * Record the head's current position into the trail. points[last] always
   * sits on the head; a new point is committed once the head has travelled
   * one spacing away from the previous committed point.
   */
  recordTrail(s: Snake): void {
    const pts = s.points;
    const head = pts[pts.length - 1];
    const anchor = pts[pts.length - 2];
    if (!head || !anchor) {
      pts.push({ x: s.x, y: s.y });
    } else {
      const sp = spacingOf(s.mass);
      if (dist2(s.x, s.y, anchor.x, anchor.y) >= sp * sp) {
        pts.push({ x: s.x, y: s.y });
      } else {
        head.x = s.x;
        head.y = s.y;
      }
    }
    this.trimBody(s);
  }

  /** Move the head forward one tick without any rules (client prediction). */
  moveHead(s: Snake, dt: number): void {
    const speed = s.boosting ? BOOST_SPEED : BASE_SPEED;
    s.x += Math.cos(s.angle) * speed * dt;
    s.y += Math.sin(s.angle) * speed * dt;
  }

  private advance(s: Snake, dt: number): void {
    if (s.invuln > 0) s.invuln = Math.max(0, s.invuln - dt);
    this.moveHead(s, dt);
    this.recordTrail(s);

    if (s.boosting) {
      const drain = boostDrainOf(s.mass) * dt;
      s.mass -= drain;
      s.dropped += dt;
      if (s.dropped >= BOOST_DROP_EVERY) {
        s.dropped = 0;
        const tail = s.points[0];
        if (tail) {
          const v = Math.round(boostDrainOf(s.mass) * BOOST_DROP_EVERY * 0.85 * 10) / 10;
          this.addFood({
            x: tail.x + randRange(-4, 4),
            y: tail.y + randRange(-4, 4),
            v: Math.max(0.3, v),
            c: this.skinFoodColor(s.skin),
            r: 4 + Math.random() * 1.6,
            k: 1,
          });
        }
      }
      if (s.mass < MIN_MASS) {
        s.mass = MIN_MASS;
        s.boosting = false;
        s.boostLeft = 0;
      }
    }

    const rr = ARENA_RADIUS - radiusOf(s.mass) * 0.5;
    if (s.x * s.x + s.y * s.y > rr * rr) {
      if (s.invuln > 0) {
        const d = Math.hypot(s.x, s.y) || 1;
        s.x = (s.x / d) * rr * 0.98;
        s.y = (s.y / d) * rr * 0.98;
        s.angle = Math.atan2(-s.y, -s.x);
      } else {
        this.kill(s, "wall", null, null);
      }
    }
  }

  trimBody(s: Snake): void {
    const want = lengthOf(s.mass);
    const pts = s.points;
    if (pts.length < 2) return;
    let total = 0;
    for (let i = pts.length - 1; i > 0; i--) {
      const a = pts[i]!;
      const b = pts[i - 1]!;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (total + d >= want) {
        const t = clamp((want - total) / Math.max(d, 1e-6), 0, 1);
        b.x = a.x + (b.x - a.x) * t;
        b.y = a.y + (b.y - a.y) * t;
        if (i - 1 > 0) pts.splice(0, i - 1);
        break;
      }
      total += d;
    }
    const cap = maxPointsOf(s.mass) + 40;
    if (pts.length > cap) pts.splice(0, pts.length - cap);
  }

  // ── bots ───────────────────────────────────────────────────────────────────

  /**
   * Free space in front of a point: distance to the nearest foreign body
   * (minus that body's radius) or to the rim, whichever is closer.
   */
  private clearance(self: Snake, px: number, py: number, cap: number): number {
    let best = Math.min(cap, ARENA_RADIUS - Math.hypot(px, py) - radiusOf(self.mass));
    for (const o of this.snakes) {
      if (o === self || !o.alive) continue;
      const orad = radiusOf(o.mass);
      const reach = cap + lengthOf(o.mass) + orad;
      if (dist2(px, py, o.x, o.y) > reach * reach) continue;
      const pts = o.points;
      const stride = Math.max(1, Math.ceil(pts.length / 48));
      for (let i = 0; i < pts.length; i += stride) {
        const q = pts[i]!;
        const d = Math.sqrt(dist2(px, py, q.x, q.y)) - orad;
        if (d < best) best = d;
      }
      const dh = Math.sqrt(dist2(px, py, o.x, o.y)) - orad;
      if (dh < best) best = dh;
    }
    return best;
  }

  private thinkBot(s: Snake, dt: number): void {
    s.think -= dt;
    s.avoid -= dt;
    s.boostLeft -= dt;

    if (s.think <= 0) {
      s.think = 0.2 + Math.random() * 0.2;
      this.chooseGoal(s);
    }
    if (s.avoid <= 0) {
      s.avoid = 0.08;
      this.pickHeading(s);
    }

    this.steerHeading(s, s.wander, dt);
    s.boosting = s.boostLeft > 0 && s.mass > MIN_MASS + 6;
  }

  /** Long-horizon intent: flee, coil, hunt, eat, or drift. Stored in `wander`. */
  private chooseGoal(s: Snake): void {
    const r = radiusOf(s.mass);
    const bold = s.temper;
    const far = Math.hypot(s.x, s.y);
    if (far > ARENA_RADIUS * 0.86) {
      s.wander = Math.atan2(-s.y, -s.x) + randRange(-0.5, 0.5);
      s.boostLeft = 0;
      return;
    }

    // Flee a bigger head that is close and pointed at us.
    let threat: Snake | null = null;
    let threatD = (300 + r * 4) ** 2;
    for (const o of this.snakes) {
      if (o === s || !o.alive || o.mass < s.mass * (1.05 + bold * 0.4)) continue;
      const d = dist2(s.x, s.y, o.x, o.y);
      if (d > threatD) continue;
      const toward = Math.abs(wrapAngle(Math.atan2(s.y - o.y, s.x - o.x) - o.angle));
      if (toward < 1.1) {
        threatD = d;
        threat = o;
      }
    }
    if (threat) {
      s.wander = Math.atan2(s.y - threat.y, s.x - threat.x) + randRange(-0.4, 0.4);
      if (Math.random() < 0.6) s.boostLeft = 0.35 + Math.random() * 0.4;
      return;
    }

    // Coil: a big snake wraps a much smaller one that strayed inside its reach.
    if (s.mass > 140) {
      let prey: Snake | null = null;
      let preyD = (lengthOf(s.mass) * 0.32) ** 2;
      for (const o of this.snakes) {
        if (o === s || !o.alive || o.invuln > 0 || o.mass > s.mass * 0.4) continue;
        const d = dist2(s.x, s.y, o.x, o.y);
        if (d < preyD) {
          preyD = d;
          prey = o;
        }
      }
      if (prey) {
        // Orbit the prey clockwise, biased inward so the loop tightens.
        const out = Math.atan2(s.y - prey.y, s.x - prey.x);
        const d = Math.sqrt(preyD);
        const ring = Math.max(
          radiusOf(prey.mass) * 4 + r * 2,
          (lengthOf(s.mass) / (2 * Math.PI)) * 0.9,
        );
        const inward = clamp((d - ring) / ring, -0.6, 0.6);
        s.wander = out + Math.PI / 2 + inward * 0.9;
        s.boostLeft = 0;
        return;
      }
    }

    // Hunt: cut across the path of a smaller snake that is ahead of us.
    let prey: Snake | null = null;
    let preyD = (300 + r * 3 + bold * 200) ** 2;
    for (const o of this.snakes) {
      if (o === s || !o.alive || o.mass > s.mass * (0.6 + bold * 0.35) || o.invuln > 0) continue;
      const d = dist2(s.x, s.y, o.x, o.y);
      if (d > preyD) continue;
      const ahead = Math.abs(wrapAngle(Math.atan2(o.y - s.y, o.x - s.x) - s.angle));
      if (ahead < 1.6) {
        preyD = d;
        prey = o;
      }
    }
    if (prey && s.mass > 18 && Math.random() < 0.35 + bold * 0.6) {
      const lead = 70 + radiusOf(prey.mass) * 2 + (prey.boosting ? BOOST_SPEED : BASE_SPEED) * 0.45;
      s.wander = Math.atan2(
        prey.y + Math.sin(prey.angle) * lead - s.y,
        prey.x + Math.cos(prey.angle) * lead - s.x,
      );
      if (Math.sqrt(preyD) < 280 && Math.random() < 0.3 + bold * 0.5)
        s.boostLeft = 0.3 + Math.random() * 0.5;
      return;
    }

    // Eat: nearest worthwhile orb, clusters and remains preferred.
    let best: Food | null = null;
    let bestScore = 0;
    const nearby = this.queryFood(s.x, s.y, 520);
    for (const f of nearby) {
      const d = Math.sqrt(dist2(s.x, s.y, f.x, f.y));
      const ahead = Math.abs(wrapAngle(Math.atan2(f.y - s.y, f.x - s.x) - s.angle));
      const score = (f.v + 0.4) / (d + 60) / (1 + ahead * 0.4);
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    if (best) {
      s.wander = Math.atan2(best.y - s.y, best.x - s.x);
      if (best.k === 3 && Math.random() < 0.2 + bold * 0.4) s.boostLeft = 0.4;
      return;
    }
    s.wander = wrapAngle(s.angle + randRange(-0.9, 0.9));
  }

  /** Short-horizon safety: bend the goal heading toward open space. */
  private pickHeading(s: Snake): void {
    const r = radiusOf(s.mass);
    const speed = s.boosting ? BOOST_SPEED : BASE_SPEED;
    const look = speed * 0.55 + r * 3.5;
    const safe = r * 2.6 + 26;
    const cap = look + safe;
    const goal = s.wander;
    const offsets = [0, -0.5, 0.5, -1.0, 1.0, -1.6, 1.6, -2.3, 2.3];
    let bestAngle = goal;
    let bestScore = -Infinity;
    let goalClear = -Infinity;
    for (const off of offsets) {
      const a = goal + off;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const c1 = this.clearance(s, s.x + dx * look, s.y + dy * look, cap);
      const c2 = this.clearance(s, s.x + dx * look * 0.5, s.y + dy * look * 0.5, cap);
      const c = Math.min(c1, c2);
      if (off === 0) goalClear = c;
      const turn = Math.abs(wrapAngle(a - s.angle));
      const score = Math.min(c, safe * 2) - Math.abs(off) * 6 - turn * 4;
      if (score > bestScore) {
        bestScore = score;
        bestAngle = a;
      }
    }
    if (goalClear >= safe) {
      s.wander = goal;
      return;
    }
    s.wander = wrapAngle(bestAngle);
    if (goalClear < r * 1.4) s.boostLeft = 0;
  }

  // ── orbs ───────────────────────────────────────────────────────────────────

  /** Pull loose orbs toward every head. Cosmetic on clients, real on servers. */
  magnet(dt: number): void {
    const step = MAGNET_SPEED * dt;
    for (const s of this.snakes) {
      if (!s.alive) continue;
      const r = radiusOf(s.mass);
      const range = r * 2.3 + 18;
      const range2 = range * range;
      const nearby = this.queryFood(s.x, s.y, range);
      for (const f of nearby) {
        if (f.k === 3) continue;
        const d2 = dist2(f.x, f.y, s.x, s.y);
        if (d2 > range2) continue;
        const d = Math.sqrt(d2) || 1;
        const pull = Math.min(step * (1.2 - (d / range) * 0.6), d);
        this.moveFood(f, f.x + ((s.x - f.x) / d) * pull, f.y + ((s.y - f.y) / d) * pull);
      }
    }
  }

  private moveChasers(dt: number): void {
    const sense2 = CHASE_SENSE * CHASE_SENSE;
    for (const f of this.chasers) {
      let nearest: Snake | null = null;
      let nd = sense2;
      for (const s of this.snakes) {
        if (!s.alive) continue;
        const d = dist2(f.x, f.y, s.x, s.y);
        if (d < nd) {
          nd = d;
          nearest = s;
        }
      }
      let nx = f.x;
      let ny = f.y;
      if (nearest) {
        const d = Math.sqrt(nd) || 1;
        const away =
          Math.atan2(f.y - nearest.y, f.x - nearest.x) + Math.sin(f.x * 0.01 + f.y * 0.013) * 0.6;
        const k = clamp(1.4 - d / CHASE_SENSE, 0.4, 1.2);
        nx += Math.cos(away) * CHASE_SPEED * k * dt;
        ny += Math.sin(away) * CHASE_SPEED * k * dt;
      } else {
        nx += Math.cos(f.x * 0.003 + f.y * 0.002) * 30 * dt;
        ny += Math.sin(f.y * 0.003 - f.x * 0.002) * 30 * dt;
      }
      const lim = ARENA_RADIUS * 0.92;
      const rr = Math.hypot(nx, ny);
      if (rr > lim) {
        nx = (nx / rr) * lim;
        ny = (ny / rr) * lim;
      }
      this.moveFood(f, nx, ny);
    }
  }

  private resolveEats(): void {
    for (const s of this.snakes) {
      if (!s.alive) continue;
      const gains = this.owned(s);
      const reach = radiusOf(s.mass) + 3;
      const nearby = this.queryFood(s.x, s.y, reach + 18);
      for (const f of nearby) {
        if (dist2(s.x, s.y, f.x, f.y) > (reach + f.r * 0.6) ** 2) continue;
        if (gains) {
          s.mass += f.v;
          this.eats.push({ x: f.x, y: f.y, v: f.v, c: f.c, id: s.id });
        }
        this.removeFood(f);
      }
    }
  }

  private resolveKills(): void {
    for (const s of this.snakes) {
      if (!s.alive || s.invuln > 0) continue;
      if (!this.owned(s)) continue;
      const hr = radiusOf(s.mass) * 0.8;
      for (const o of this.snakes) {
        if (o.id === s.id || !o.alive) continue;
        const orad = radiusOf(o.mass);
        const hitR = hr + orad * 0.88;
        const hitR2 = hitR * hitR;
        const reach = lengthOf(o.mass) + hitR + 24;
        if (dist2(s.x, s.y, o.x, o.y) > reach * reach) continue;
        // Head on head: both lose.
        if (dist2(s.x, s.y, o.x, o.y) <= hitR2) {
          this.kill(s, "snake", o.id, o.name);
          break;
        }
        const pts = o.points;
        if (pts.length < 2) continue;
        const minX = s.x - hitR;
        const maxX = s.x + hitR;
        const minY = s.y - hitR;
        const maxY = s.y + hitR;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]!;
          const b = pts[i]!;
          if ((a.x < minX && b.x < minX) || (a.x > maxX && b.x > maxX)) continue;
          if ((a.y < minY && b.y < minY) || (a.y > maxY && b.y > maxY)) continue;
          if (pointSegDist2(s.x, s.y, a.x, a.y, b.x, b.y) <= hitR2) {
            this.kill(s, "snake", o.id, o.name);
            break;
          }
        }
        if (!s.alive) break;
      }
    }
  }

  private kill(
    s: Snake,
    reason: "wall" | "snake",
    killerId: string | null,
    killerName: string | null,
  ): void {
    if (!s.alive) return;
    s.alive = false;
    s.boosting = false;
    // Like slither.io, the rim eats you whole: no remains.
    const pellets = reason === "wall" ? [] : this.pelletsFrom(s);
    for (const p of pellets) this.addFood(p);
    if (killerId) {
      const k = this.snakes.find((x) => x.id === killerId);
      if (k && k.alive) k.kills++;
    }
    this.deaths.push({ snake: s, reason, killerId, killerName, pellets });
  }

  /** Kill from outside the tick (a disconnected player is dropped, for one). */
  killSnake(id: string): void {
    const s = this.snakes.find((x) => x.id === id);
    if (s) this.kill(s, "snake", null, null);
  }

  private cullDead(): void {
    this.snakes = this.snakes.filter((s) => s.alive);
  }

  private maintainBots(dt: number): void {
    if (!this.host) return;
    const bots = this.snakes.reduce((n, s) => n + (s.isBot && s.alive ? 1 : 0), 0);
    if (bots >= this.desiredBots) {
      this.botTimer = BOT_RESPAWN_DELAY;
      return;
    }
    this.botTimer -= dt;
    if (this.botTimer > 0) return;
    this.botTimer = BOT_RESPAWN_DELAY * randRange(0.6, 1.4);
    const used = new Set(this.snakes.map((s) => s.name.toLowerCase()));
    this.spawnBot(used);
  }

  private makeFood(): Food {
    // A share of orbs spawn beside an existing natural orb, which builds the
    // loose clusters slither.io has instead of a uniform sprinkle.
    let at: Vec | null = null;
    if (this.foods.length > 50 && Math.random() < 0.45) {
      const near = this.foods[(Math.random() * this.foods.length) | 0]!;
      if (near.k === 0) {
        const p = { x: near.x + randRange(-70, 70), y: near.y + randRange(-70, 70) };
        if (p.x * p.x + p.y * p.y < (ARENA_RADIUS * 0.96) ** 2) at = p;
      }
    }
    const p = at ?? randomInDisk(ARENA_RADIUS * 0.96);
    const roll = Math.random();
    const prize = roll < 0.03;
    const mid = !prize && roll < 0.2;
    const v = prize ? 3 + ((Math.random() * 3) | 0) : mid ? 2 : 1;
    return {
      x: p.x,
      y: p.y,
      v,
      c: (Math.random() * FOOD_COLORS.length) | 0,
      r: prize
        ? 7.5 + Math.random() * 4
        : mid
          ? 4.6 + Math.random() * 2
          : 2.8 + Math.random() * 1.6,
      k: 0,
    };
  }

  private makeChaser(): Food {
    const p = randomInDisk(ARENA_RADIUS * 0.85);
    return { x: p.x, y: p.y, v: 14 + ((Math.random() * 8) | 0), c: CHASE_COLOR, r: 13, k: 3 };
  }

  private fillFood(target: number): void {
    while (this.foods.length < target) this.addFood(this.makeFood());
    while (this.chasers.length < CHASE_ORBS) this.addFood(this.makeChaser());
  }

  private maintainFood(): void {
    let n = 0;
    while (this.foods.length < FOOD_TARGET && n++ < 24) this.addFood(this.makeFood());
    if (this.chasers.length < CHASE_ORBS && Math.random() < 0.02) this.addFood(this.makeChaser());
    if (this.foods.length > FOOD_TARGET + 2500) {
      for (let i = 0; i < 12; i++) {
        const f = this.foods[(Math.random() * this.foods.length) | 0]!;
        if (f.k === 0 && f.v <= 1) this.removeFood(f);
      }
    }
  }
}
