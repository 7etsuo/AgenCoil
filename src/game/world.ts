import {
  ARENA_RADIUS,
  BASE_SPEED,
  BOOST_DRAIN,
  BOOST_DROP_EVERY,
  BOOST_SPEED,
  FOOD_COLORS,
  FOOD_TARGET,
  MIN_MASS,
  SPAWN_INVULN,
  START_MASS,
  type Food,
  type Snake,
  type Vec,
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

const CELL = 96;

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

export class World {
  snakes: Snake[] = [];
  foods: Food[] = [];
  playerId: string | null = null;
  host = true;
  eats: EatEvent[] = [];
  deaths: DeathEvent[] = [];
  private grid = new Map<string, number[]>();
  private foodCursor = 0;

  get player(): Snake | undefined {
    return this.snakes.find((s) => s.id === this.playerId);
  }

  resetLocalBots(n: number): void {
    this.snakes = this.snakes.filter((s) => !s.isBot);
    const used = new Set(this.snakes.map((s) => s.name.toLowerCase()));
    for (let i = 0; i < n; i++) this.spawnBot(used);
  }

  clearBots(): void {
    this.snakes = this.snakes.filter((s) => !s.isBot);
  }

  spawnPlayer(id: string, name: string, skin: number): Snake {
    this.snakes = this.snakes.filter((s) => s.id !== id);
    const s = this.makeSnake(id, name, skin, false);
    this.playerId = id;
    this.snakes.push(s);
    return s;
  }

  spawnBot(used: Set<string>): Snake {
    const name = pickBotName(used);
    used.add(name.toLowerCase());
    const s = this.makeSnake(`b-${Math.random().toString(36).slice(2, 9)}`, name, (Math.random() * 16) | 0, true);
    s.mass = START_MASS + Math.random() * 36;
    if (Math.random() < 0.22) s.mass += 70 + Math.random() * 140;
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
      think: Math.random() * 0.4,
      avoid: 0,
      avoidDir: 1,
      boostLeft: 0,
      dropped: 0,
    };
    this.ensureTrail(s);
    return s;
  }

  removeSnake(id: string, drop = false): void {
    const s = this.snakes.find((x) => x.id === id);
    if (!s) return;
    if (drop && s.alive) this.kill(s, "wall", null, null);
    this.snakes = this.snakes.filter((x) => x.id !== id);
  }

  upsertRemote(s: Snake): void {
    const i = this.snakes.findIndex((x) => x.id === s.id);
    if (i >= 0) this.snakes[i] = s;
    else this.snakes.push(s);
  }

  addFood(f: Food): void {
    this.foods.push(f);
    this.indexFood(this.foods.length - 1);
  }

  pelletsFrom(s: Snake): Food[] {
    const out: Food[] = [];
    const n = Math.min(90, 8 + Math.floor(s.mass * 0.42));
    const pts = s.points.length ? s.points : [{ x: s.x, y: s.y }];
    for (let i = 0; i < n; i++) {
      const p = pts[((i / n) * (pts.length - 1)) | 0]!;
      out.push({
        x: p.x + randRange(-6, 6),
        y: p.y + randRange(-6, 6),
        v: 1 + ((Math.random() * 2) | 0),
        c: s.skin % FOOD_COLORS.length,
        r: 7 + Math.random() * 7,
      });
    }
    return out;
  }

  cosmeticEatNear(x: number, y: number, reach: number): void {
    const hit = this.queryFood(x, y, reach);
    hit.sort((a, b) => b - a);
    const seen = new Set<number>();
    for (const idx of hit) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      const f = this.foods[idx];
      if (!f) continue;
      if (dist2(x, y, f.x, f.y) <= (reach + f.r) * (reach + f.r)) this.removeFoodAt(idx);
    }
  }

  step(dt: number, aimX: number, aimY: number, wantBoost: boolean): void {
    this.deaths = [];
    this.eats = [];
    this.maintainFood();

    for (const s of this.snakes) {
      if (!s.alive) continue;
      if (s.id === this.playerId) {
        this.steerToward(s, aimX, aimY, dt);
        s.boosting = wantBoost && s.mass > MIN_MASS + 0.4;
        this.advance(s, dt);
      } else if (s.isBot && this.host) {
        this.thinkBot(s, dt);
        this.advance(s, dt);
      }
    }

    this.resolveEats();
    this.resolveKills();
    this.cullDead();
  }

  private findSpawn(): Vec {
    for (let n = 0; n < 18; n++) {
      const p = randomInDisk(ARENA_RADIUS * 0.72);
      let ok = true;
      for (const s of this.snakes) {
        if (!s.alive) continue;
        if (dist2(p.x, p.y, s.x, s.y) < 220 * 220) {
          ok = false;
          break;
        }
      }
      if (ok) return p;
    }
    return randomInDisk(ARENA_RADIUS * 0.5);
  }

  private ensureTrail(s: Snake): void {
    if (s.points.length) return;
    const sp = spacingOf(s.mass);
    const n = Math.max(8, Math.round(lengthOf(s.mass) / sp));
    for (let i = n - 1; i >= 0; i--) {
      s.points.push({
        x: s.x - Math.cos(s.angle) * sp * (n - i),
        y: s.y - Math.sin(s.angle) * sp * (n - i),
      });
    }
  }

  private steerToward(s: Snake, tx: number, ty: number, dt: number): void {
    const desired = Math.atan2(ty - s.y, tx - s.x);
    const maxTurn = turnRateOf(s.mass) * dt;
    const delta = wrapAngle(desired - s.angle);
    s.angle += clamp(delta, -maxTurn, maxTurn);
  }

  private advance(s: Snake, dt: number): void {
    if (s.invuln > 0) s.invuln = Math.max(0, s.invuln - dt);
    const speed = s.boosting ? BOOST_SPEED : BASE_SPEED;
    s.x += Math.cos(s.angle) * speed * dt;
    s.y += Math.sin(s.angle) * speed * dt;

    const pts = s.points;
    const last = pts[pts.length - 1];
    if (!last) {
      pts.push({ x: s.x, y: s.y });
    } else {
      const dx = s.x - last.x;
      const dy = s.y - last.y;
      const sp = spacingOf(s.mass);
      if (dx * dx + dy * dy >= sp * sp) pts.push({ x: s.x, y: s.y });
      else {
        last.x = s.x;
        last.y = s.y;
      }
    }
    this.trimBody(s);

    if (s.boosting) {
      s.mass -= BOOST_DRAIN * dt;
      s.dropped += dt;
      if (s.dropped >= BOOST_DROP_EVERY) {
        s.dropped = 0;
        const tail = s.points[0];
        if (tail) {
          this.addFood({
            x: tail.x + randRange(-3, 3),
            y: tail.y + randRange(-3, 3),
            v: 1,
            c: s.skin % FOOD_COLORS.length,
            r: 4.2 + Math.random() * 1.8,
          });
        }
      }
      if (s.mass < MIN_MASS) {
        s.mass = MIN_MASS;
        s.boosting = false;
        s.boostLeft = 0;
      }
    }

    const rr = ARENA_RADIUS - radiusOf(s.mass) * 0.6;
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

  private trimBody(s: Snake): void {
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

  private thinkBot(s: Snake, dt: number): void {
    s.think -= dt;
    s.avoid -= dt;
    s.boostLeft -= dt;

    const wall = Math.hypot(s.x, s.y);
    const danger = ARENA_RADIUS * 0.82;
    if (wall > danger) {
      this.steerToward(s, 0, 0, dt);
      s.boosting = false;
      return;
    }

    const look = (s.boosting ? BOOST_SPEED : BASE_SPEED) * 0.4 + radiusOf(s.mass) * 3;
    const fx = s.x + Math.cos(s.angle) * look;
    const fy = s.y + Math.sin(s.angle) * look;
    const lookR = look * 0.45;
    let blocked = false;
    for (const o of this.snakes) {
      if (o.id === s.id || !o.alive) continue;
      const orad = radiusOf(o.mass);
      const maxd = look + lengthOf(o.mass) + orad;
      if (dist2(s.x, s.y, o.x, o.y) > maxd * maxd) continue;
      const hit = (lookR + orad) * (lookR + orad);
      const stride = Math.max(1, (o.points.length / 24) | 0);
      for (let i = 0; i < o.points.length; i += stride) {
        const p = o.points[i]!;
        if (dist2(fx, fy, p.x, p.y) < hit) {
          blocked = true;
          break;
        }
      }
      if (blocked) break;
    }
    if (blocked) {
      if (s.avoid <= 0) s.avoidDir = Math.random() < 0.5 ? -1 : 1;
      s.avoid = 0.35;
      s.angle += s.avoidDir * turnRateOf(s.mass) * dt * 1.4;
      s.boosting = false;
      return;
    }

    if (s.think <= 0) {
      s.think = 0.18 + Math.random() * 0.25;
      let best: Food | null = null;
      let bestScore = Infinity;
      const nearbyFood = this.queryFood(s.x, s.y, 420);
      for (const idx of nearbyFood) {
        const f = this.foods[idx];
        if (!f) continue;
        const d = dist2(s.x, s.y, f.x, f.y);
        const score = d / (f.v + 0.5);
        if (score < bestScore) {
          bestScore = score;
          best = f;
        }
      }
      if (best) s.wander = Math.atan2(best.y - s.y, best.x - s.x);
      else s.wander += randRange(-0.7, 0.7);

      let hunt: Snake | null = null;
      let huntD = 380 * 380;
      for (const o of this.snakes) {
        if (o.id === s.id || !o.alive) continue;
        if (o.mass > s.mass * 0.9) continue;
        const d = dist2(s.x, s.y, o.x, o.y);
        if (d < huntD) {
          huntD = d;
          hunt = o;
        }
      }
      if (hunt && s.mass > 16) {
        const lead = 80 + radiusOf(hunt.mass);
        s.wander = Math.atan2(
          hunt.y + Math.sin(hunt.angle) * lead - s.y,
          hunt.x + Math.cos(hunt.angle) * lead - s.x,
        );
        s.boostLeft = 0.4 + Math.random() * 0.5;
      }
    }

    this.steerToward(s, s.x + Math.cos(s.wander) * 80, s.y + Math.sin(s.wander) * 80, dt);
    s.boosting = s.boostLeft > 0 && s.mass > MIN_MASS + 4;
  }

  private resolveEats(): void {
    for (const s of this.snakes) {
      if (!s.alive) continue;
      if (!(s.id === this.playerId || (s.isBot && this.host))) continue;
      const reach = radiusOf(s.mass) + 10;
      const nearby = this.queryFood(s.x, s.y, reach + 16);
      const hit: number[] = [];
      for (const idx of nearby) {
        const f = this.foods[idx];
        if (!f) continue;
        if (dist2(s.x, s.y, f.x, f.y) <= (reach + f.r) * (reach + f.r)) hit.push(idx);
      }
      hit.sort((a, b) => b - a);
      const seen = new Set<number>();
      for (const idx of hit) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const f = this.foods[idx];
        if (!f) continue;
        s.mass += f.v;
        this.eats.push({ x: f.x, y: f.y, v: f.v, c: f.c, id: s.id });
        this.removeFoodAt(idx);
      }
    }
  }

  private resolveKills(): void {
    for (const s of this.snakes) {
      if (!s.alive || s.invuln > 0) continue;
      if (!(s.id === this.playerId || (s.isBot && this.host))) continue;
      const hr = radiusOf(s.mass) * 0.7;
      for (const o of this.snakes) {
        if (o.id === s.id || !o.alive) continue;
        const orad = radiusOf(o.mass);
        const hitR = hr + orad * 0.9;
        const hitR2 = hitR * hitR;
        const reach = lengthOf(o.mass) + hitR + 24;
        if (dist2(s.x, s.y, o.x, o.y) > reach * reach) continue;
        const pts = o.points;
        if (pts.length < 2) continue;
        let end = 1;
        let acc = 0;
        const skipDist = (hr + orad) * 1.2;
        for (let i = pts.length - 1; i > 1; i--) {
          acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
          if (acc >= skipDist) {
            end = i;
            break;
          }
        }
        const minX = s.x - hitR;
        const maxX = s.x + hitR;
        const minY = s.y - hitR;
        const maxY = s.y + hitR;
        for (let i = 1; i < end; i++) {
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

  private kill(s: Snake, reason: "wall" | "snake", killerId: string | null, killerName: string | null): void {
    if (!s.alive) return;
    s.alive = false;
    s.boosting = false;
    const pellets = this.pelletsFrom(s);
    for (const p of pellets) this.addFood(p);
    this.deaths.push({ snake: s, reason, killerId, killerName, pellets });
  }

  private cullDead(): void {
    this.snakes = this.snakes.filter((s) => s.alive);
  }

  private makeFood(at?: Vec, v = 0, c = -1): Food {
    const p = at ?? randomInDisk(ARENA_RADIUS * 0.93);
    const roll = Math.random();
    const prize = !v && roll < 0.035;
    const mid = !v && !prize && roll < 0.2;
    return {
      x: p.x,
      y: p.y,
      v: v || (prize ? 4 + ((Math.random() * 3) | 0) : mid ? 2 : 1),
      c: c >= 0 ? c : (Math.random() * FOOD_COLORS.length) | 0,
      r: prize ? 8 + Math.random() * 5 : mid ? 4.6 + Math.random() * 2.2 : 2.5 + Math.random() * 1.6,
    };
  }

  private maintainFood(): void {
    let n = 0;
    while (this.foods.length < FOOD_TARGET && n++ < 8) this.addFood(this.makeFood());
    if (this.foods.length > FOOD_TARGET + 180) {
      for (let i = this.foods.length - 1; i >= 0 && this.foods.length > FOOD_TARGET; i--) {
        if (this.foods[i]!.r < 5 && Math.random() < 0.08) this.removeFoodAt(i);
      }
    }
  }

  queryFood(x: number, y: number, r: number): number[] {
    const out: number[] = [];
    const x0 = Math.floor((x - r) / CELL);
    const x1 = Math.floor((x + r) / CELL);
    const y0 = Math.floor((y - r) / CELL);
    const y1 = Math.floor((y + r) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const bucket = this.grid.get(`${gx}:${gy}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  private indexFood(idx: number): void {
    const f = this.foods[idx];
    if (!f) return;
    const key = `${Math.floor(f.x / CELL)}:${Math.floor(f.y / CELL)}`;
    const bucket = this.grid.get(key);
    if (bucket) bucket.push(idx);
    else this.grid.set(key, [idx]);
  }

  private rebuildGrid(): void {
    this.grid.clear();
    for (let i = 0; i < this.foods.length; i++) this.indexFood(i);
  }

  private removeFoodAt(idx: number): void {
    const last = this.foods.length - 1;
    this.foods[idx] = this.foods[last]!;
    this.foods.pop();
    this.foodCursor++;
    if (this.foodCursor > 24) {
      this.foodCursor = 0;
      this.rebuildGrid();
    } else {
      this.rebuildGrid();
    }
  }
}
