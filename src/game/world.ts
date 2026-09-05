import {
  ARENA_RADIUS,
  BOOST_DROP_EVERY,
  BOOST_MIN_MASS,
  BOT_RESPAWN_DELAY,
  CHASE_COLOR,
  CHASE_ORBS,
  FOOD_COLORS,
  FOOD_TARGET,
  MAGNET_SPEED,
  MIN_MASS,
  NEAR_COOLDOWN,
  NEAR_FACTOR,
  SWARM_ORBS,
  BOSS_HP,
  BOSS_HIT_MASS,
  BOSS_MASS,
  BOSS_NAME,
  LANDMARKS,
  MAX_CUSTOM_BANDS,
  REMAINS_CAP,
  SERVER_TICK_HZ,
  SKINS,
  SPAWN_INVULN,
  START_MASS,
  type Food,
  type Snake,
  type SnakeBox,
  type Vec,
  bandsOf,
  boostDrainOf,
  clamp,
  foodColorOf,
  dist2,
  lengthOf,
  maxPointsOf,
  pickBotName,
  pointSegDist2,
  radiusOf,
  randRange,
  randomInDisk,
  spacingOf,
  speedOf,
  turnRateOf,
  wrapAngle,
} from "./model";

export const CELL = 96;
/** Fraction of the summed radii at which two snakes count as touching. */
const HIT_CONTACT = 0.95;
/** Longest view lag a player may be compensated for, in seconds. */
const MAX_LAG_COMP = 0.35;
/** Ticks of travel and tail history kept for rewinds (0.5 s at the server rate). */
const TRAVEL_LOG = Math.ceil(SERVER_TICK_HZ / 2);
const TAIL_HIST = SERVER_TICK_HZ;
/** Ticks between two boss hits by the same attacker (one second). */
const BOSS_HIT_EVERY = SERVER_TICK_HZ;
/** Ticks the boss spends heading for one landmark before moving on. */
const BOSS_LEG_TICKS = SERVER_TICK_HZ * 45;
/** Bots past this length boost freely, shedding what they cannot use. */
const BOT_SOFT_CAP = 2000;
/** Bots past this length retire soon after, turning into a big pile of remains. */
const BOT_HARD_CAP = 4500;
const GRID_OFF = 256;
const GRID_SPAN = 512;
/**
 * Food is kept at an even density. The arena is cut into regions of this
 * size, each with a share of FOOD_TARGET, and new orbs go to regions below
 * their share. Placing them uniformly instead let the interior, where
 * everyone eats, thin out while the untouched rim filled up, until circling
 * the edge was the best way to grow.
 */
const REGION = CELL * 8;
const REGION_OFF = 16;
const REGION_SPAN = 32;
/** Orbs spawn inside this fraction of the radius. */
const FOOD_EXTENT = 0.96;
function regionKey(x: number, y: number): number {
  return (
    (Math.floor(x / REGION) + REGION_OFF) * REGION_SPAN + (Math.floor(y / REGION) + REGION_OFF)
  );
}
const CHASE_SPEED = 265;
const CHASE_SENSE = 320;

export interface EatEvent {
  x: number;
  y: number;
  v: number;
  c: number;
  id: string;
  /** Orb kind eaten (2 = remains), for challenge tracking. */
  k: number;
}

/** A head skimmed past another snake without touching. */
export interface NearEvent {
  id: string;
  otherId: string;
  x: number;
  y: number;
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

/** 400-unit cells used for the death heat map. */
export const HOT_CELL = 400;
const HOT_OFF = 64;
const HOT_SPAN = 128;
export function hotKey(x: number, y: number): number {
  return (Math.floor(x / HOT_CELL) + HOT_OFF) * HOT_SPAN + (Math.floor(y / HOT_CELL) + HOT_OFF);
}
/** The centre of the heat-map cell behind a key from `hotKey`. */
export function hotCellCentre(key: number): Vec {
  const gx = Math.floor(key / HOT_SPAN) - HOT_OFF;
  const gy = (key % HOT_SPAN) - HOT_OFF;
  return { x: (gx + 0.5) * HOT_CELL, y: (gy + 0.5) * HOT_CELL };
}

/** Total length of a point path. */
export function pathLength(pts: Vec[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    len += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return len;
}

export function cellKey(x: number, y: number): number {
  return cellKeyOf(Math.floor(x / CELL), Math.floor(y / CELL));
}

/** The key of a food cell by its grid coordinates (see `cellKey`). */
export function cellKeyOf(gx: number, gy: number): number {
  return (gx + GRID_OFF) * GRID_SPAN + (gy + GRID_OFF);
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
  /**
   * Per player: how far in the past (seconds) their screen shows other
   * snakes. Collisions for that player are judged against other snakes
   * rewound by that much, so what they saw is what kills them.
   */
  lags = new Map<string, number>();
  /** Arena mode modifiers (server), see challenges.ts MODES. */
  remainsMult = 1;
  hunger = 0;
  eats: EatEvent[] = [];
  /** Events of the last step. Deaths caused between steps are surfaced by the next one. */
  deaths: DeathEvent[] = [];
  nears: NearEvent[] = [];
  private queuedDeaths: DeathEvent[] = [];
  private stepping = false;
  /** Snakes to check for near misses (players; bots do not earn them). */
  nearIds = new Set<string>();
  foodById = new Map<number, Food>();
  /** Coarse cells (see `hotKey`) to avoid when spawning: recent death sites. */
  hot = new Set<number>();
  private grid = new Map<number, Food[]>();
  /**
   * A stamp per food cell, bumped by every add, remove or move that touches
   * it, so a client's food sync can skip cells nothing has happened in.
   * Stamps come from one counter and are never reused.
   */
  private cellStamps = new Map<number, number>();
  private foodSeq = 0;
  private foodIndex = new Map<Food, number>();
  /** Food regions: each region's share of the target, and how many orbs it holds. */
  private readonly regionQuota = new Map<number, number>();
  private readonly regionKeys: number[] = [];
  private readonly regionCount = new Map<number, number>();
  /** Where the last natural orb went, so a share of spawns can cluster beside it. */
  private lastSpawn: Vec | null = null;
  private pool: { keys: number[]; cum: number[]; total: number } | null = null;
  private chasers: Food[] = [];
  private botTimer = 0;
  private nextFoodId = 1;
  private nextBotId = 1;

  constructor(fill = true) {
    this.initRegions();
    if (fill) this.fillFood(FOOD_TARGET);
  }

  /** Each region's share of the food target is its share of the arena's area. */
  private initRegions(): void {
    const lim = ARENA_RADIUS * FOOD_EXTENT;
    const cells = new Map<number, number>();
    let total = 0;
    for (let x = -lim + CELL / 2; x < lim; x += CELL) {
      for (let y = -lim + CELL / 2; y < lim; y += CELL) {
        if (x * x + y * y > lim * lim) continue;
        const k = regionKey(x, y);
        cells.set(k, (cells.get(k) ?? 0) + 1);
        total++;
      }
    }
    for (const [k, n] of cells) {
      this.regionQuota.set(k, (FOOD_TARGET * n) / total);
      this.regionKeys.push(k);
    }
  }

  /** How many more orbs a region wants, as a fraction of its share (0 when full). */
  private regionDeficit(key: number): number {
    const quota = this.regionQuota.get(key);
    if (!quota) return 0;
    return Math.max(0, quota - (this.regionCount.get(key) ?? 0)) / quota;
  }

  /**
   * Regions below their share, weighted by how far below they are, so a
   * spawn can pick one in proportion. Rebuilt per batch of spawns.
   */
  private deficitPool(): { keys: number[]; cum: number[]; total: number } {
    const keys: number[] = [];
    const cum: number[] = [];
    let total = 0;
    for (const k of this.regionKeys) {
      const d = this.regionDeficit(k);
      if (d <= 0) continue;
      total += d;
      keys.push(k);
      cum.push(total);
    }
    return { keys, cum, total };
  }

  /**
   * A spawn point in a region below its share, the further below the more
   * likely; a quarter of orbs land beside the previous one when its region
   * still has room, for slither.io's loose clusters. Anywhere at all only
   * when every region is full.
   */
  private spawnPoint(pool: { keys: number[]; cum: number[]; total: number }): Vec {
    const lim = ARENA_RADIUS * FOOD_EXTENT;
    const lim2 = lim * lim;
    const last = this.lastSpawn;
    if (last && Math.random() < 0.25 && this.regionDeficit(regionKey(last.x, last.y)) > 0) {
      const p = { x: last.x + randRange(-70, 70), y: last.y + randRange(-70, 70) };
      if (p.x * p.x + p.y * p.y < lim2) return p;
    }
    for (let attempt = 0; attempt < 4 && pool.total > 0; attempt++) {
      const r = Math.random() * pool.total;
      let lo = 0;
      let hi = pool.cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pool.cum[mid]! < r) lo = mid + 1;
        else hi = mid;
      }
      const k = pool.keys[lo]!;
      const rx = Math.floor(k / REGION_SPAN) - REGION_OFF;
      const ry = (k % REGION_SPAN) - REGION_OFF;
      for (let t = 0; t < 4; t++) {
        const p = { x: (rx + Math.random()) * REGION, y: (ry + Math.random()) * REGION };
        if (p.x * p.x + p.y * p.y < lim2) return p;
      }
    }
    return randomInDisk(lim);
  }

  get player(): Snake | undefined {
    return this.snakes.find((s) => s.id === this.playerId);
  }

  resetLocalBots(n: number): void {
    this.snakes = this.snakes.filter((s) => !s.isBot);
    const used = new Set(this.snakes.map((s) => s.name.toLowerCase()));
    // The opening population has a spread of sizes; later respawns start
    // small and earn their length, so no long body is ever laid across a
    // player.
    for (let i = 0; i < n; i++) this.spawnBot(used, true);
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
    if (bands && bands.length) s.bands = bands.slice(0, MAX_CUSTOM_BANDS);
    if (mass && mass > START_MASS) {
      s.mass = mass;
      s.points = [];
      this.ensureTrail(s);
    }
    this.snakes.push(s);
    return s;
  }

  spawnBot(used: Set<string>, grown = false): Snake {
    const name = pickBotName(used);
    used.add(name.toLowerCase());
    const s = this.makeSnake(
      `b${this.nextBotId++}`,
      name,
      (Math.random() * SKINS.length) | 0,
      true,
    );
    s.mass = START_MASS + Math.random() * 20;
    if (grown) {
      const roll = Math.random();
      if (roll < 0.35) s.mass += 60 + Math.random() * 160;
      if (roll < 0.1) s.mass += 300 + Math.random() * 700;
    }
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
      skin: skin % SKINS.length,
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
    this.inputs.delete(id);
    this.lags.delete(id);
    this.nearIds.delete(id);
    const s = this.snakes.find((x) => x.id === id);
    if (!s) return;
    if (drop && s.alive) this.kill(s, "snake", null, null);
    this.snakes = this.snakes.filter((x) => x.id !== id);
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
    this.bucket(f, cellKey(f.x, f.y));
    if (f.k === 3) this.chasers.push(f);
    return f;
  }

  private bucket(f: Food, key: number, countRegion = true): void {
    const bucket = this.grid.get(key);
    if (bucket) bucket.push(f);
    else this.grid.set(key, [f]);
    this.cellStamps.set(key, ++this.foodSeq);
    if (!countRegion) return;
    const rk = regionKey(f.x, f.y);
    this.regionCount.set(rk, (this.regionCount.get(rk) ?? 0) + 1);
  }

  /** The stamp of a food cell: equal stamps mean the cell's orbs are unchanged. */
  foodCellStamp(key: number): number {
    return this.cellStamps.get(key) ?? 0;
  }

  /** The orbs in one cell, if any. */
  foodsInCell(key: number): readonly Food[] | undefined {
    return this.grid.get(key);
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
    for (const key of this.grid.keys()) this.cellStamps.set(key, ++this.foodSeq);
    this.foods = [];
    this.foodById.clear();
    this.foodIndex.clear();
    this.grid.clear();
    this.regionCount.clear();
    this.chasers = [];
  }

  private unbucket(f: Food, countRegion = true): void {
    const key = cellKey(f.x, f.y);
    const bucket = this.grid.get(key);
    if (!bucket) return;
    const i = bucket.indexOf(f);
    if (i >= 0) {
      bucket[i] = bucket[bucket.length - 1]!;
      bucket.pop();
    }
    if (!bucket.length) this.grid.delete(key);
    this.cellStamps.set(key, ++this.foodSeq);
    if (!countRegion) return;
    const rk = regionKey(f.x, f.y);
    const n = (this.regionCount.get(rk) ?? 1) - 1;
    if (n > 0) this.regionCount.set(rk, n);
    else this.regionCount.delete(rk);
  }

  moveFood(f: Food, x: number, y: number): void {
    const before = cellKey(f.x, f.y);
    const after = cellKey(x, y);
    if (before === after) {
      f.x = x;
      f.y = y;
      return;
    }
    // The region tally only moves when the orb changes region, which a
    // magnet pull rarely does.
    const sameRegion = regionKey(f.x, f.y) === regionKey(x, y);
    this.unbucket(f, !sameRegion);
    f.x = x;
    f.y = y;
    this.bucket(f, after, !sameRegion);
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

  /**
   * The glowing remains a snake leaves behind: worth most of its mass, laid
   * along the body about one orb per two body points so they read as orbs
   * rather than a second snake, and coloured by the bands the snake wore,
   * counted from the head the way the renderer paints them.
   */
  pelletsFrom(s: Snake): Food[] {
    const out: Food[] = [];
    const pts = s.points.length ? s.points : [{ x: s.x, y: s.y }];
    const n = Math.round(clamp(Math.min(8 + s.mass * 0.3, pts.length / 2), 8, 150));
    // Only bots take the event multiplier: their mass is capped, so doubling
    // it cannot run away, while player remains fed back into players did.
    const mult = s.isBot ? this.remainsMult : 1;
    const each = Math.max(1, Math.min(REMAINS_CAP, s.mass * 0.85 * mult) / n);
    const colors = bandsOf(s).map(foodColorOf);
    const bandLen = Math.max(1, s.bands?.length ? 3 : SKINS[s.skin % SKINS.length]!.band);
    for (let i = 0; i < n; i++) {
      const j = ((i / n) * (pts.length - 1)) | 0;
      const p = pts[j]!;
      const fromHead = pts.length - 1 - j;
      const v = Math.round(each * randRange(0.7, 1.3) * 10) / 10;
      out.push({
        x: p.x + randRange(-9, 9),
        y: p.y + randRange(-9, 9),
        v,
        c: colors[Math.floor(fromHead / bandLen) % colors.length]!,
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
    // Deaths caused since the last step (a disconnect timer, the boss clock)
    // belong to this one, so the server broadcasts and books them like any other.
    this.deaths = this.queuedDeaths;
    this.queuedDeaths = [];
    this.eats = [];
    this.nears = [];
    this.stepping = true;
    try {
      this.advanceAll(dt, aimX, aimY, wantBoost);
    } finally {
      this.stepping = false;
    }
  }

  private advanceAll(dt: number, aimX: number, aimY: number, wantBoost: boolean): void {
    this.maintainFood();
    this.maintainBots(dt);

    for (const s of this.snakes) {
      if (!s.alive) continue;
      const input = this.inputs.get(s.id);
      if (input) {
        this.steerHeading(s, input.angle, dt);
        s.boosting = input.boost && s.mass > BOOST_MIN_MASS;
        if (this.hunger > 0) s.mass = Math.max(MIN_MASS, s.mass - s.mass * this.hunger * dt);
        this.advance(s, dt);
      } else if (s.id === this.playerId) {
        this.steerToward(s, aimX, aimY, dt);
        s.boosting = wantBoost && s.mass > BOOST_MIN_MASS;
        this.advance(s, dt);
      } else if (s.isBot && this.host) {
        this.thinkBot(s, dt);
        this.advance(s, dt);
      }
    }

    this.refreshBoxes();
    this.magnet(dt);
    this.moveChasers(dt);
    this.resolveEats();
    this.resolveKills();
    this.resolveNearMisses();
    this.cullDead();
  }

  /**
   * Derived geometry and a bounding box per live snake, once per step. The
   * pair loops below test a head against the box before walking a body, and
   * read radius and length from here instead of calling `scaleOf` per pair.
   */
  private refreshBoxes(): void {
    for (const s of this.snakes) {
      if (!s.alive) continue;
      const b = (s.box ??= { r: 0, len: 0, boostSpeed: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 });
      b.r = radiusOf(s.mass);
      b.len = lengthOf(s.mass);
      b.boostSpeed = speedOf(s.mass, true);
      let minX = s.x;
      let maxX = s.x;
      let minY = s.y;
      let maxY = s.y;
      const pts = s.points;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        if (p.x < minX) minX = p.x;
        else if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        else if (p.y > maxY) maxY = p.y;
      }
      b.minX = minX;
      b.maxX = maxX;
      b.minY = minY;
      b.maxY = maxY;
    }
  }

  /** Is the point within `pad` of the box (the body it encloses can be that close)? */
  private static nearBox(b: SnakeBox, x: number, y: number, pad: number): boolean {
    return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
  }

  /**
   * Close calls: a player's head passing inside NEAR_FACTOR of the summed
   * radii of another snake's body without touching it, once per snake per
   * cooldown. Bots are excluded so nobody farms a parked bot.
   */
  private resolveNearMisses(): void {
    if (!this.nearIds.size) return;
    const now = performance.now();
    for (const s of this.snakes) {
      if (!s.alive || s.invuln > 0 || !this.nearIds.has(s.id) || !s.box) continue;
      const hr = s.box.r;
      for (const o of this.snakes) {
        if (o.id === s.id || !o.alive || o.invuln > 0 || o.mass < 30 || !o.box) continue;
        const nearR = (hr + o.box.r) * NEAR_FACTOR;
        if (!World.nearBox(o.box, s.x, s.y, nearR)) continue;
        const last = s.nearMark?.get(o.id);
        if (last !== undefined && now - last < NEAR_COOLDOWN * 1000) continue;
        const pts = o.points;
        let best = Infinity;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]!;
          const b = pts[i]!;
          if (Math.abs(a.x - s.x) > nearR && Math.abs(b.x - s.x) > nearR) continue;
          if (Math.abs(a.y - s.y) > nearR && Math.abs(b.y - s.y) > nearR) continue;
          const d = pointSegDist2(s.x, s.y, a.x, a.y, b.x, b.y);
          if (d < best) best = d;
        }
        if (best <= nearR * nearR) {
          if (!s.nearMark) s.nearMark = new Map();
          s.nearMark.set(o.id, now);
          this.nears.push({ id: s.id, otherId: o.id, x: s.x, y: s.y });
        }
      }
    }
  }

  /** Drop a cluster of golden orbs around a point: an arena event. */
  spawnGoldSwarm(x: number, y: number, n = SWARM_ORBS): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * 260;
      this.addFood({
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d,
        v: 4 + ((Math.random() * 4) | 0),
        c: CHASE_COLOR,
        r: 9 + Math.random() * 4,
        k: 4,
      });
    }
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
      if (n < 16 && this.hot.has(hotKey(p.x, p.y))) continue;
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

  /** A random open point well inside the rim, for events. */
  randomOpenPoint(): Vec {
    return this.findSpawn();
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
    const c = this.pathOf(s);
    let head = pts[pts.length - 1];
    const anchor = pts[pts.length - 2];
    if (!head || !anchor) {
      pts.push({ x: s.x, y: s.y });
      c.n = pts.length;
      c.len = pathLength(pts);
    } else {
      // Committed points sit exactly one spacing apart along the line the
      // head travelled, however far it moved this tick. (Fixing the old
      // head where it was a tick earlier made segments alternate long and
      // short, so slow big snakes carried far more points than their length
      // allowed and were cut short by the point cap.)
      const sp = spacingOf(s.mass);
      const prevLast = Math.hypot(head.x - anchor.x, head.y - anchor.y);
      let ax = anchor.x;
      let ay = anchor.y;
      let d = Math.hypot(s.x - ax, s.y - ay);
      let committed = 0;
      while (d >= sp) {
        const t = sp / d;
        ax += (s.x - ax) * t;
        ay += (s.y - ay) * t;
        head.x = ax;
        head.y = ay;
        head = { x: s.x, y: s.y };
        pts.push(head);
        committed++;
        d -= sp;
      }
      head.x = s.x;
      head.y = s.y;
      c.len += committed * sp + d - prevLast;
      c.n = pts.length;
    }
    this.trimBody(s);
  }

  /** The running path length for a snake, rebuilt when its points were replaced or edited elsewhere. */
  private pathOf(s: Snake): { pts: Vec[]; n: number; len: number } {
    const pts = s.points;
    let c = s.path;
    if (!c || c.pts !== pts || c.n !== pts.length) {
      c = { pts, n: pts.length, len: pathLength(pts) };
      s.path = c;
    }
    return c;
  }

  /** Move the head forward one tick without any rules (client prediction). */
  moveHead(s: Snake, dt: number): void {
    const speed = speedOf(s.mass, s.boosting) * (s.boss ? 0.55 : 1);
    s.x += Math.cos(s.angle) * speed * dt;
    s.y += Math.sin(s.angle) * speed * dt;
  }

  private advance(s: Snake, dt: number): void {
    if (s.invuln > 0) s.invuln = Math.max(0, s.invuln - dt);
    const bx = s.x;
    const by = s.y;
    this.moveHead(s, dt);
    // Exact per-tick travel, so a rewind for lag compensation follows what
    // the snake actually did, boosting or not.
    const log = (s.travel ??= []);
    log.push(Math.hypot(s.x - bx, s.y - by));
    if (log.length > TRAVEL_LOG) log.shift();
    this.recordTrail(s);

    if (s.boosting) {
      const drain = boostDrainOf(s.mass) * dt;
      s.mass -= drain;
      s.dropped += dt;
      if (s.dropped >= BOOST_DROP_EVERY) {
        s.dropped = 0;
        const tail = s.points[0];
        if (tail) {
          const v = Math.round(boostDrainOf(s.mass) * BOOST_DROP_EVERY * 0.9 * 10) / 10;
          this.addFood({
            x: tail.x + randRange(-4, 4),
            y: tail.y + randRange(-4, 4),
            v: Math.max(0.3, v),
            c: this.skinFoodColor(s.skin),
            r: 4.5 + Math.random() * 1.5,
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

  /**
   * Cut the tail so the body is `lengthOf(mass)` long: whole tail points go
   * while the rest still reaches that length, then the last one is slid
   * along its segment to land exactly. Runs from the running path length, so
   * a body that only moved costs a couple of segment measurements.
   */
  trimBody(s: Snake): void {
    const want = lengthOf(s.mass);
    const pts = s.points;
    if (pts.length < 2) return;
    const c = this.pathOf(s);
    let drop = 0;
    while (pts.length - drop > 2) {
      const a = pts[drop]!;
      const b = pts[drop + 1]!;
      const seg = Math.hypot(a.x - b.x, a.y - b.y);
      if (c.len - seg < want) break;
      c.len -= seg;
      drop++;
    }
    if (drop > 0) {
      // Keep what the tail is about to lose: a rewind may need it.
      const hist = (s.tailHist ??= []);
      for (let j = 0; j < drop; j++) hist.push(pts[j]!);
      if (hist.length > TAIL_HIST) hist.splice(0, hist.length - TAIL_HIST);
      pts.splice(0, drop);
      c.n = pts.length;
    }
    const excess = c.len - want;
    if (excess > 0) {
      const a = pts[0]!;
      const b = pts[1]!;
      const seg = Math.hypot(a.x - b.x, a.y - b.y);
      const t = clamp(excess / Math.max(seg, 1e-6), 0, 1);
      a.x += (b.x - a.x) * t;
      a.y += (b.y - a.y) * t;
      c.len = want;
    }
    const cap = maxPointsOf(s.mass) + 40;
    if (pts.length > cap) {
      pts.splice(0, pts.length - cap);
      c.n = pts.length;
      c.len = pathLength(pts);
    }
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
      // Boxes are from the last step; a body moves under 30 units in one.
      const box = o.box;
      const orad = box ? box.r : radiusOf(o.mass);
      if (box) {
        if (!World.nearBox(box, px, py, cap + orad + 30)) continue;
      } else {
        const reach = cap + lengthOf(o.mass) + orad;
        if (dist2(px, py, o.x, o.y) > reach * reach) continue;
      }
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

  /** Boss hits landed this tick: attacker id and hit point, for the server to credit. */
  bossHits: { attacker: string; x: number; y: number; hp: number; killed: boolean }[] = [];
  private tickN = 0;

  /** Spawn the Boss Hour snake near a landmark. */
  spawnBoss(at: Vec): Snake {
    const s = this.makeSnake("boss", BOSS_NAME, 13, true);
    s.mass = BOSS_MASS;
    s.boss = true;
    s.hp = BOSS_HP;
    s.hpMax = BOSS_HP;
    s.temper = 0.2;
    s.x = at.x;
    s.y = at.y;
    s.angle = Math.random() * Math.PI * 2;
    s.points = [];
    this.ensureTrail(s);
    s.invuln = 0;
    this.snakes.push(s);
    return s;
  }

  /** The boss patrols between landmarks slowly and never boosts. */
  private thinkBoss(s: Snake, dt: number): void {
    s.think -= dt;
    s.avoid -= dt;
    if (s.think <= 0) {
      s.think = 0.5;
      const idx = Math.floor(this.tickN / BOSS_LEG_TICKS) % LANDMARKS.length;
      const t = LANDMARKS[idx]!;
      const d = Math.hypot(t.x - s.x, t.y - s.y);
      s.wander =
        d < 400
          ? s.angle + randRange(-0.6, 0.6)
          : Math.atan2(t.y - s.y, t.x - s.x) + randRange(-0.3, 0.3);
    }
    if (s.avoid <= 0) {
      s.avoid = 0.08;
      this.pickHeading(s);
    }
    this.steerHeading(s, s.wander, dt * 0.6);
    s.boosting = false;
  }

  private thinkBot(s: Snake, dt: number): void {
    if (s.boss) {
      this.thinkBoss(s, dt);
      return;
    }
    s.think -= dt;
    s.avoid -= dt;
    s.boostLeft -= dt;

    if (s.think <= 0) {
      s.think = 0.2 + Math.random() * 0.2;
      this.chooseGoal(s);
      // Without enough players to hunt them, bots would compound forever
      // and the arena would fill with giants. Big bots get reckless and
      // shed length; the very biggest retire into remains for the rest.
      if (s.mass > BOT_SOFT_CAP && Math.random() < 0.5) s.boostLeft = 0.4;
      if (s.mass > BOT_HARD_CAP && Math.random() < 0.02) {
        this.kill(s, "snake", null, null);
        return;
      }
    }
    if (s.avoid <= 0) {
      s.avoid = 0.08;
      this.pickHeading(s);
    }

    this.steerHeading(s, s.wander, dt);
    s.boosting = s.boostLeft > 0 && s.mass > BOOST_MIN_MASS + 5;
  }

  /** Long-horizon intent: flee, coil, hunt, eat, or drift. Stored in `wander`. */
  private chooseGoal(s: Snake): void {
    const r = radiusOf(s.mass);
    const bold = clamp(s.temper + s.mass / 4000, 0, 1);
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
        if (o.rookie) continue;
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
      // Rookies get openings: bots rarely hunt them, and never with a boost.
      if (o.rookie && Math.random() < 0.75) continue;
      const d = dist2(s.x, s.y, o.x, o.y);
      if (d > preyD) continue;
      const ahead = Math.abs(wrapAngle(Math.atan2(o.y - s.y, o.x - s.x) - s.angle));
      if (ahead < 1.6) {
        preyD = d;
        prey = o;
      }
    }
    if (prey && s.mass > 18 && Math.random() < 0.35 + bold * 0.6) {
      const lead = 70 + radiusOf(prey.mass) * 2 + speedOf(prey.mass, prey.boosting) * 0.45;
      s.wander = Math.atan2(
        prey.y + Math.sin(prey.angle) * lead - s.y,
        prey.x + Math.cos(prey.angle) * lead - s.x,
      );
      if (!prey.rookie && Math.sqrt(preyD) < 280 && Math.random() < 0.3 + bold * 0.5)
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
    const speed = speedOf(s.mass, s.boosting);
    const look = speed * 0.55 + r * 3.5;
    const safe = r * 2.6 + 26;
    const cap = look + safe;
    const goal = s.wander;
    // The common case: the way we already want to go is clear. Check it
    // alone before paying for the full fan of candidate headings.
    const goalClear = Math.min(
      this.clearance(s, s.x + Math.cos(goal) * look, s.y + Math.sin(goal) * look, cap),
      this.clearance(s, s.x + Math.cos(goal) * look * 0.5, s.y + Math.sin(goal) * look * 0.5, cap),
    );
    if (goalClear >= safe) {
      s.wander = goal;
      return;
    }
    const offsets = [-0.5, 0.5, -1.0, 1.0, -1.6, 1.6, -2.3, 2.3];
    let bestAngle = goal;
    let bestScore = Math.min(goalClear, safe * 2) - Math.abs(wrapAngle(goal - s.angle)) * 4;
    for (const off of offsets) {
      const a = goal + off;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const c1 = this.clearance(s, s.x + dx * look, s.y + dy * look, cap);
      const c2 = this.clearance(s, s.x + dx * look * 0.5, s.y + dy * look * 0.5, cap);
      const c = Math.min(c1, c2);
      const turn = Math.abs(wrapAngle(a - s.angle));
      const score = Math.min(c, safe * 2) - Math.abs(off) * 6 - turn * 4;
      if (score > bestScore) {
        bestScore = score;
        bestAngle = a;
      }
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
          this.eats.push({ x: f.x, y: f.y, v: f.v, c: f.c, id: s.id, k: f.k });
        }
        this.removeFood(f);
      }
    }
  }

  /**
   * Where a snake's head was `lag` seconds ago and how much of its body
   * existed then: the head is walked back along the body by the distance it
   * has travelled since. Returns the index of the last body point that was
   * already behind that head, and the rewound head position.
   */
  private rewind(o: Snake, lag: number): { cut: number; hx: number; hy: number; d: number } {
    const pts = o.points;
    // Distance actually travelled over the lag window, from the tick log;
    // fall back to nominal speed if the log is short.
    const ticks = Math.round(lag * SERVER_TICK_HZ);
    let d = 0;
    const log = o.travel ?? [];
    if (log.length >= ticks) {
      for (let i = log.length - ticks; i < log.length; i++) d += log[i]!;
    } else {
      d = speedOf(o.mass, o.boosting) * lag;
    }
    const dist = d;
    let hx = o.x;
    let hy = o.y;
    let cut = pts.length - 1;
    for (let i = pts.length - 1; i > 0 && d > 0; i--) {
      const a = pts[i]!;
      const b = pts[i - 1]!;
      const seg = Math.hypot(a.x - b.x, a.y - b.y);
      if (seg >= d) {
        const t = seg > 0 ? d / seg : 0;
        hx = a.x + (b.x - a.x) * t;
        hy = a.y + (b.y - a.y) * t;
        cut = i - 1;
        d = 0;
        break;
      }
      d -= seg;
      hx = b.x;
      hy = b.y;
      cut = i - 1;
    }
    return { cut, hx, hy, d: dist };
  }

  /**
   * The tail as it was `d` units of travel ago: the body then extended past
   * the current tail along the recently trimmed points.
   */
  private tailThen(o: Snake, d: number): Vec[] {
    const hist = o.tailHist;
    if (!hist || !hist.length || d <= 0) return [];
    const out: Vec[] = [];
    let left = d;
    let prev: Vec = o.points[0]!;
    for (let i = hist.length - 1; i >= 0 && left > 0; i--) {
      const q = hist[i]!;
      const seg = Math.hypot(prev.x - q.x, prev.y - q.y);
      if (seg >= left) {
        const t = seg > 0 ? left / seg : 0;
        out.push({ x: prev.x + (q.x - prev.x) * t, y: prev.y + (q.y - prev.y) * t });
        break;
      }
      out.push(q);
      left -= seg;
      prev = q;
    }
    return out;
  }

  private resolveKills(): void {
    // Every head is judged against the state at the start of the tick: the
    // kills are collected here and applied after both loops, so a head-on
    // collision kills both snakes instead of only the one processed first.
    const kills: { s: Snake; o: Snake }[] = [];
    this.tickN++;
    const hits: { s: Snake; o: Snake }[] = [];
    for (const s of this.snakes) {
      if (!s.alive || s.invuln > 0 || !s.box) continue;
      if (!this.owned(s)) continue;
      const hr = s.box.r;
      const lag = Math.min(MAX_LAG_COMP, this.lags.get(s.id) ?? 0);
      for (const o of this.snakes) {
        // Spawn protection works both ways: a fresh snake neither dies nor
        // kills, so nobody can be farmed by (or farm) a respawn.
        if (o === s || !o.alive || o.invuln > 0 || !o.box) continue;
        // Death on visual contact, as in slither.io: the drawn discs have
        // radius r, so the sum of radii is where they touch.
        const hitR = (hr + o.box.r) * HIT_CONTACT;
        // The body as this player saw it may trail the current one by what
        // it travelled in the lag window, so the box is padded by that much.
        if (!World.nearBox(o.box, s.x, s.y, hitR + lag * o.box.boostSpeed)) continue;
        const headOn = this.touches(s, o, hitR, lag);
        if (headOn === null) continue;
        // Touching the boss's body is a cut, not a death; its head still kills.
        if (o.boss && !headOn) {
          hits.push({ s, o });
          continue;
        }
        kills.push({ s, o });
        break;
      }
    }
    for (const k of kills) this.kill(k.s, "snake", k.o.id, k.o.name);
    for (const h of hits) this.bossHit(h.s, h.o);
  }

  /**
   * Does head `s` touch snake `o` as `s`'s player saw it `lag` seconds ago?
   * Returns true for a head-on contact, false for a body contact, and null
   * for no contact.
   */
  private touches(s: Snake, o: Snake, hitR: number, lag: number): boolean | null {
    const hitR2 = hitR * hitR;
    // Lag compensation: the other snake as this player last saw it.
    const rw = lag > 0 ? this.rewind(o, lag) : { cut: o.points.length - 1, hx: o.x, hy: o.y, d: 0 };
    // Head on head: both lose.
    if (dist2(s.x, s.y, rw.hx, rw.hy) <= hitR2) return true;
    const pts = o.points;
    if (pts.length < 2) return null;
    const minX = s.x - hitR;
    const maxX = s.x + hitR;
    const minY = s.y - hitR;
    const maxY = s.y + hitR;
    const end = Math.min(pts.length - 1, rw.cut);
    for (let i = 1; i <= end; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if ((a.x < minX && b.x < minX) || (a.x > maxX && b.x > maxX)) continue;
      if ((a.y < minY && b.y < minY) || (a.y > maxY && b.y > maxY)) continue;
      if (pointSegDist2(s.x, s.y, a.x, a.y, b.x, b.y) <= hitR2) return false;
    }
    // The partial segment between the last kept point and the rewound head.
    if (end < pts.length - 1) {
      const a = pts[end]!;
      if (pointSegDist2(s.x, s.y, a.x, a.y, rw.hx, rw.hy) <= hitR2) return false;
    }
    // And the stretch of tail that still existed then.
    if (rw.d > 0) {
      let prev: Vec = pts[0]!;
      for (const q of this.tailThen(o, rw.d)) {
        if (pointSegDist2(s.x, s.y, prev.x, prev.y, q.x, q.y) <= hitR2) return false;
        prev = q;
      }
    }
    return null;
  }

  /**
   * A player's head cutting the boss: once per second per attacker it costs
   * the boss a hit point, sheds a few remains at the cut and feeds the
   * attacker. The final hit kills the boss like any snake (big remains).
   */
  private bossHit(s: Snake, o: Snake): void {
    if (!o.alive || s.isBot) return;
    const marks = (o.bossHitAt ??= new Map());
    const last = marks.get(s.id);
    if (last !== undefined && this.tickN - last < BOSS_HIT_EVERY) return;
    marks.set(s.id, this.tickN);
    o.hp = Math.max(0, (o.hp ?? 1) - 1);
    s.mass += BOSS_HIT_MASS;
    for (let i = 0; i < 3; i++) {
      this.addFood({
        x: s.x + randRange(-30, 30),
        y: s.y + randRange(-30, 30),
        v: 3,
        c: this.skinFoodColor(o.skin),
        r: 7,
        k: 2,
      });
    }
    const killed = o.hp <= 0;
    this.bossHits.push({ attacker: s.id, x: s.x, y: s.y, hp: o.hp, killed });
    if (killed) this.kill(o, "snake", s.id, s.name);
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
      // The killer may have died in the same tick (a head-on): kills are
      // collected against the tick's starting state and applied together,
      // so both heads are credited, whichever the loop reached first.
      const k = this.snakes.find((x) => x.id === killerId);
      if (k) k.kills++;
    }
    const event: DeathEvent = { snake: s, reason, killerId, killerName, pellets };
    if (this.stepping) this.deaths.push(event);
    else this.queuedDeaths.push(event);
    this.lags.delete(s.id);
  }

  /** Kill from outside the tick (a disconnected player is dropped, for one). */
  killSnake(id: string): void {
    const s = this.snakes.find((x) => x.id === id);
    if (s) this.kill(s, "snake", null, null);
  }

  private cullDead(): void {
    if (this.snakes.some((s) => !s.alive)) this.snakes = this.snakes.filter((s) => s.alive);
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

  private makeFood(pool: { keys: number[]; cum: number[]; total: number }): Food {
    const p = this.spawnPoint(pool);
    this.lastSpawn = p;
    const roll = Math.random();
    const prize = roll < 0.02;
    const mid = !prize && roll < 0.12;
    const small = !prize && !mid && roll < 0.45;
    const v = prize ? 3 + ((Math.random() * 2) | 0) : mid ? 2 : small ? 1 : 0.6;
    const r = prize
      ? 8 + Math.random() * 4
      : mid
        ? 5.5 + Math.random() * 2
        : small
          ? 4 + Math.random() * 1.5
          : 3 + Math.random() * 1.2;
    return {
      x: p.x,
      y: p.y,
      v,
      c: (Math.random() * FOOD_COLORS.length) | 0,
      r,
      k: 0,
    };
  }

  private makeChaser(): Food {
    const p = randomInDisk(ARENA_RADIUS * 0.85);
    return { x: p.x, y: p.y, v: 30 + ((Math.random() * 50) | 0), c: CHASE_COLOR, r: 14, k: 3 };
  }

  private fillFood(target: number): void {
    while (this.foods.length < target) {
      const pool = this.deficitPool();
      for (let i = 0; i < 200 && this.foods.length < target; i++) this.addFood(this.makeFood(pool));
    }
    while (this.chasers.length < CHASE_ORBS) this.addFood(this.makeChaser());
  }

  private maintainFood(): void {
    if (this.foods.length < FOOD_TARGET) {
      // Shortfalls move slowly, so the pool is rebuilt every few steps.
      if (!this.pool || this.tickN % 8 === 0) this.pool = this.deficitPool();
      let n = 0;
      while (this.foods.length < FOOD_TARGET && n++ < 24) this.addFood(this.makeFood(this.pool));
    }
    if (this.chasers.length < CHASE_ORBS && Math.random() < 0.02) this.addFood(this.makeChaser());
    if (this.foods.length > FOOD_TARGET + 2500) {
      for (let i = 0; i < 12; i++) {
        const f = this.foods[(Math.random() * this.foods.length) | 0]!;
        if (f.k === 0 && f.v <= 1) this.removeFood(f);
      }
    }
  }
}
