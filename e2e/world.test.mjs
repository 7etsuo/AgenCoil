// Simulation rules that must hold regardless of the client or the server.
// The shared TypeScript is bundled on the fly so Node can import it directly.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("../game-server/node_modules/esbuild");
const root = new URL("..", import.meta.url).pathname;

let World;
let model;
let wisp;
let mod;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "agencoil-world-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `export * from "${root}src/game/world.ts"; export * as model from "${root}src/game/model.ts"; export * as wisp from "${root}src/game/wisp.ts";`,
  );
  const out = join(dir, "world.mjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  mod = await import(pathToFileURL(out).href);
  World = mod.World;
  model = mod.model;
  wisp = mod.wisp;
});

function place(world, id, x, y, angle, mass = 60) {
  const s = world.spawnSnake(id, id, 0, false, undefined, mass);
  s.x = x;
  s.y = y;
  s.angle = angle;
  s.invuln = 0;
  s.points = [];
  world.ensureTrail(s);
  world.inputs.set(id, { angle, boost: false });
  return s;
}

function stepUntil(world, pred, maxSteps = 600) {
  for (let i = 0; i < maxSteps; i++) {
    world.step(1 / 40, 0, 0, false);
    if (pred()) return i;
  }
  return -1;
}

test("a head-on collision kills both snakes", () => {
  const world = new World(false);
  world.host = true;
  const a = place(world, "a", -150, 0, 0);
  const b = place(world, "b", 150, 0, Math.PI);
  const died = new Set();
  const n = stepUntil(world, () => {
    for (const d of world.deaths) died.add(d.snake.id);
    return died.size === 2;
  });
  assert.ok(n >= 0, "both should die within the step budget");
  assert.ok(died.has(a.id) && died.has(b.id));
  assert.equal(world.snakes.length, 0);
  // Each head took the other down; which one the loop reached first is no reason to credit only it.
  assert.equal(a.kills, 1);
  assert.equal(b.kills, 1);
});

test("a spawn-protected snake cannot win a head-on", () => {
  const world = new World(false);
  world.host = true;
  const fresh = place(world, "fresh", -150, 0, 0);
  fresh.invuln = 5;
  const vet = place(world, "vet", 150, 0, Math.PI);
  const died = [];
  stepUntil(
    world,
    () => {
      for (const d of world.deaths) died.push(d.snake.id);
      return died.length > 0 || Math.hypot(fresh.x - vet.x, fresh.y - vet.y) > 800;
    },
    200,
  );
  assert.ok(!died.includes(vet.id), "the veteran must not die to a protected head");
});

test("running into a body kills only the runner and leaves remains", () => {
  const world = new World(false);
  world.host = true;
  // The wall snake drives away along +y, so its body lies across y = 0 while
  // its head is far from the runner's path.
  const wall = place(world, "wall", 0, 300, Math.PI / 2, 400);
  const runner = place(world, "runner", -300, 0, 0, 40);
  const foodsBefore = world.foods.length;
  const died = [];
  stepUntil(world, () => {
    for (const d of world.deaths) died.push(d.snake.id);
    return died.length > 0;
  });
  assert.deepEqual(died, [runner.id]);
  assert.ok(world.snakes.some((s) => s.id === wall.id));
  assert.ok(world.foods.length > foodsBefore, "remains should be dropped");
  assert.equal(wall.kills, 1);
});

test("the trail follows the head and keeps the body length", () => {
  const world = new World(false);
  world.host = true;
  const s = place(world, "s", 0, 0, 0, 100);
  world.inputs.get("s").angle = 1.2;
  stepUntil(world, () => false, 120);
  assert.ok(s.points.length > 20, `expected a recorded trail, got ${s.points.length} points`);
  let len = 0;
  for (let i = 1; i < s.points.length; i++)
    len += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y);
  const want = model.lengthOf(s.mass);
  assert.ok(
    Math.abs(len - want) < model.spacingOf(s.mass) * 2,
    `length ${len.toFixed(0)} vs ${want.toFixed(0)}`,
  );
});

test("slither.io tuning: turning circle stays within two widths at every size", () => {
  for (const mass of [10, 100, 1000, 4000, 12000, 25000]) {
    const r = model.radiusOf(mass);
    const circle = model.speedOf(mass, false) / model.turnRateOf(mass);
    assert.ok(
      circle / (2 * r) < 2,
      `mass ${mass}: circle ${circle.toFixed(0)} vs width ${(2 * r).toFixed(0)}`,
    );
  }
  assert.ok(Math.abs(model.speedOf(10, true) / model.speedOf(10, false) - 2.49) < 0.05);
});

test("a close pass along a body counts as a near miss, once per cooldown", () => {
  const world = new World(false);
  world.host = true;
  // The wall snake drives along +y; its body trails behind its head. The
  // runner starts beside that body, just outside touching distance, and
  // moves the same way so it stays alongside for about a second.
  const wall = place(world, "wall", 0, 300, Math.PI / 2, 400);
  const r = model.radiusOf(40) + model.radiusOf(400);
  const runner = place(world, "runner", r * 1.35, 100, Math.PI / 2, 40);
  world.nearIds.add("runner");
  let nears = 0;
  let died = false;
  let steps = 0;
  stepUntil(
    world,
    () => {
      nears += world.nears.filter((n) => n.id === "runner").length;
      died = world.deaths.length > 0;
      return died || ++steps >= 48;
    },
    60,
  );
  assert.equal(died, false, "the runner must not touch the body");
  assert.equal(nears, 1, `expected one near miss in the cooldown window, got ${nears}`);
  assert.ok(wall.alive && runner.alive);
});

test("lag compensation judges against the other snake as the player saw it", () => {
  // The other snake drives along +x. The player's head sits just ahead of
  // where that head is now, which is a head-on hit at zero lag, but with a
  // 150 ms view lag the other head is rewound behind and there is no touch.
  const build = (lag) => {
    const world = new World(false);
    world.host = true;
    const other = place(world, "other", 0, 0, 0, 200);
    const sum = model.radiusOf(20) + model.radiusOf(200);
    place(world, "me", other.x + sum * 0.7, sum * 0.6, Math.PI / 2, 20);
    world.lags.set("me", lag);
    world.inputs.get("other").angle = 0;
    // Freeze the player in place for the check: one step only.
    world.step(1 / 40, 0, 0, false);
    return world.deaths.map((d) => d.snake.id);
  };
  assert.ok(build(0).includes("me"), "at zero lag the player runs into the head");
  assert.ok(
    !build(0.15).includes("me"),
    "with 150 ms of view lag the rewound head is not there yet",
  );
});

test("rewind follows actual travel when the other snake just stopped boosting", () => {
  const world = new World(false);
  world.host = true;
  const other = place(world, "other", 0, 0, 0, 200);
  world.inputs.get("other").boost = true;
  for (let i = 0; i < 8; i++) world.step(1 / 40, 0, 0, false); // 200 ms boosting
  world.inputs.get("other").boost = false;
  world.step(1 / 40, 0, 0, false);
  // Sum of the last 8 ticks of travel (mostly boosted) vs nominal unboosted.
  const log = other.travel;
  const actual = log.slice(-8).reduce((a, b) => a + b, 0);
  const nominal = model.speedOf(other.mass, false) * 0.2;
  assert.ok(
    actual > nominal * 1.8,
    `boosted travel ${actual.toFixed(0)} should far exceed nominal ${nominal.toFixed(0)}`,
  );
  // A head placed where the nominal rewind would put the other head is NOT a
  // hit, because the real rewound head is much further back. The lag sits at
  // the compensation cap (150 ms), so the nominal distance is taken over that.
  const sum = model.radiusOf(20) + model.radiusOf(200);
  const nominalCap = model.speedOf(other.mass, false) * 0.15;
  place(world, "me", other.x - nominalCap + sum * 0.5, sum * 0.3, Math.PI / 2, 20);
  world.lags.set("me", 0.15);
  world.step(1 / 40, 0, 0, false);
  assert.ok(!world.deaths.some((d) => d.snake.id === "me"), "nominal rewind spot must be clear");
});

test("the tail that existed then still kills after a rewind", () => {
  const world = new World(false);
  world.host = true;
  const other = place(world, "other", 0, 0, 0, 60);
  for (let i = 0; i < 40; i++) world.step(1 / 40, 0, 0, false); // 1 s: the tail has moved
  const tail = other.points[0];
  // Sit just behind the current tail, where the tail was 200 ms ago.
  const back = model.speedOf(other.mass, false) * 0.15;
  const sum = model.radiusOf(20) + model.radiusOf(60);
  place(world, "me", tail.x - back, tail.y + sum * 0.5, Math.PI / 2, 20);
  const noLag = () => {
    const w2 = new World(false);
    w2.host = true;
    const o2 = place(w2, "other", 0, 0, 0, 60);
    for (let i = 0; i < 40; i++) w2.step(1 / 40, 0, 0, false);
    const t2 = o2.points[0];
    place(w2, "me", t2.x - back, t2.y + sum * 0.5, Math.PI / 2, 20);
    w2.step(1 / 40, 0, 0, false);
    return w2.deaths.some((d) => d.snake.id === "me");
  };
  world.lags.set("me", 0.2);
  world.step(1 / 40, 0, 0, false);
  assert.equal(noLag(), false, "at zero lag the spot behind the tail is clear");
  assert.ok(
    world.deaths.some((d) => d.snake.id === "me"),
    "with lag the old tail is still there",
  );
});

test("arena modes: hunger and double remains change the rules", () => {
  const world = new World(false);
  world.host = true;
  const s = place(world, "s", 0, 0, 0, 80);
  world.inputs.get("s").boost = true;
  world.step(1 / 40, 0, 0, false);
  assert.equal(s.boosting, true, "boosting is always allowed");
  world.inputs.get("s").boost = false;
  const before = s.mass;
  world.hunger = 0.5;
  world.step(1 / 40, 0, 0, false);
  assert.ok(s.mass < before, "hunger drains mass every step");
  world.hunger = 0;
  const plain = world.pelletsFrom(s).reduce((a, p) => a + p.v, 0);
  world.remainsMult = 2;
  const stillPlain = world.pelletsFrom(s).reduce((a, p) => a + p.v, 0);
  assert.ok(
    stillPlain > plain * 0.8 && stillPlain < plain * 1.2,
    `a player's remains never take the multiplier (${plain} -> ${stillPlain})`,
  );
  const bot = world.spawnBot(new Set());
  bot.mass = 80;
  world.remainsMult = 1;
  const botPlain = world.pelletsFrom(bot).reduce((a, p) => a + p.v, 0);
  world.remainsMult = 2;
  const botDoubled = world.pelletsFrom(bot).reduce((a, p) => a + p.v, 0);
  assert.ok(
    botDoubled > botPlain * 1.8 && botDoubled < botPlain * 2.2,
    `a bot's remains double (${botPlain} -> ${botDoubled})`,
  );
  // A giant's death drops at most the cap, whatever its mass.
  s.mass = 200000;
  const capped = world.pelletsFrom(s).reduce((a, p) => a + p.v, 0);
  assert.ok(
    capped <= model.REMAINS_CAP * 1.35 && capped > model.REMAINS_CAP * 0.65,
    `remains capped (${capped})`,
  );
});

test("the boss takes a hit point when a player's head touches its body, and only its head kills", () => {
  const world = new World(false);
  world.host = true;
  const boss = world.spawnBoss({ x: 0, y: 0 });
  boss.points = [];
  for (let x = -600; x <= 0; x += 20) boss.points.push({ x, y: 0 });
  boss.x = 0;
  boss.y = 0;
  boss.angle = 0;
  const s = place(world, "s", -300, 60, -Math.PI / 2, 60);
  const hpBefore = boss.hp;
  const massBefore = s.mass;
  const steps = stepUntil(world, () => boss.hp < hpBefore, 60);
  assert.ok(steps >= 0, "a cut lands");
  assert.equal(s.alive, true, "the body did not kill the attacker");
  assert.ok(s.mass > massBefore, "the attacker is fed by the cut");
  assert.equal(world.bossHits.length >= 1, true);
  // Head on head still kills the player.
  const world2 = new World(false);
  world2.host = true;
  const b2 = world2.spawnBoss({ x: 0, y: 0 });
  // Boss heading +x with its body trailing to -x; the player comes at its
  // face from +x so the first contact is head to head.
  b2.angle = 0;
  b2.wander = 0;
  b2.points = [];
  for (let x = -600; x <= 0; x += 20) b2.points.push({ x, y: 0 });
  const p = place(world2, "p", 160, 0, Math.PI, 60);
  b2.x = 0;
  b2.y = 0;
  const died = stepUntil(world2, () => !p.alive, 120);
  assert.ok(died >= 0, "the boss head kills");
});

test("the wisp turns at a bounded rate and never flips onto an aim point", () => {
  const dt = 1 / 60;
  // Aim directly behind: the old code snapped the heading around at once,
  // and with the aim point then ahead again it flipped back every frame.
  const w = { x: 0, y: 0, angle: 0 };
  wisp.steerWisp(w, { x: -240, y: 0 }, dt);
  assert.ok(Math.abs(w.angle) <= wisp.WISP_TURN * dt + 1e-9, `turned ${w.angle} in one frame`);
  assert.ok(Math.abs(w.angle) > 0, "it does start turning");
  // An aim point right on the wisp is no direction: the heading holds.
  const held = { x: 100, y: 100, angle: 1.3 };
  wisp.steerWisp(held, { x: 104, y: 97 }, dt);
  assert.equal(held.angle, 1.3);
  // Flying straight for a second covers a second of speed, no jitter.
  const flyer = { x: 0, y: 0, angle: 0 };
  for (let i = 0; i < 60; i++) wisp.moveWisp(flyer, false, dt);
  assert.ok(Math.abs(flyer.x - model.WISP_SPEED) < 1e-6 && Math.abs(flyer.y) < 1e-9);
});

test("the rim turns the wisp along the wall instead of pinning it", () => {
  const lim = model.ARENA_RADIUS - model.WISP_RIM_MARGIN;
  // Heading straight out through the rim at 3 o'clock.
  const w = { x: lim + 30, y: 0, angle: 0.2 };
  wisp.slideAlongRim(w);
  assert.ok(Math.abs(Math.hypot(w.x, w.y) - lim) < 1e-6, "back on the rim");
  const out = Math.atan2(w.y, w.x);
  const rel = model.wrapAngle(w.angle - out);
  assert.ok(Math.abs(Math.abs(rel) - Math.PI / 2) < 1e-9, `tangent, not outward (${rel})`);
  assert.ok(rel > 0, "turned toward the nearer tangent");
  // Sliding along it for a while keeps it inside and moving.
  const start = { x: w.x, y: w.y };
  for (let i = 0; i < 60; i++) {
    wisp.moveWisp(w, false, 1 / 60);
    wisp.slideAlongRim(w);
  }
  assert.ok(Math.hypot(w.x, w.y) <= lim + 1e-6);
  assert.ok(Math.hypot(w.x - start.x, w.y - start.y) > 200, "it travelled along the wall");
  // Heading inward is left alone.
  const inward = { x: lim + 5, y: 0, angle: Math.PI };
  wisp.slideAlongRim(inward);
  assert.equal(inward.angle, Math.PI);
});

test("the running body length matches a full recount through growth, shrink and edits", () => {
  const world = new World(false);
  world.host = true;
  const s = place(world, "s", 0, 0, 0, 60);
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const check = (label) => {
    const total = mod.pathLength(s.points);
    assert.ok(
      Math.abs(s.path.len - total) < 1e-6,
      `${label}: cached ${s.path.len.toFixed(3)} vs recount ${total.toFixed(3)}`,
    );
    // Boost drain lands after the trim in a step, so allow one segment of slack.
    assert.ok(
      total <= model.lengthOf(s.mass) + model.spacingOf(s.mass),
      `${label}: never longer than wanted (${total.toFixed(1)} vs ${model.lengthOf(s.mass).toFixed(1)})`,
    );
  };
  for (let i = 0; i < 300; i++) {
    world.inputs.get("s").angle += (rnd() - 0.5) * 0.8;
    world.inputs.get("s").boost = rnd() < 0.2;
    if (i % 40 === 0) s.mass += 120;
    if (i === 200) s.mass = 30;
    world.step(1 / 40, 0, 0, false);
    if (i % 5 === 0) check(`tick ${i}`);
  }
  // Points replaced wholesale (a reattached snake, a boss laid by hand): the
  // cache notices and rebuilds instead of trusting a stale length.
  s.points = s.points.slice(0, 6).map((p) => ({ ...p }));
  world.step(1 / 40, 0, 0, false);
  check("after replacing points");
  // Points edited in place outside the trail helpers are noticed by count.
  s.points.push({ x: s.x + 5, y: s.y + 5 }, { x: s.x + 10, y: s.y + 8 });
  world.step(1 / 40, 0, 0, false);
  check("after pushing points");
});

test("a slow giant keeps its full body: points sit one spacing apart, under the cap", () => {
  const world = new World(false);
  world.host = true;
  const s = place(world, "g", 0, 0, 0, 3000);
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i++) {
    world.inputs.get("g").angle += (rnd() - 0.5) * 0.3;
    world.step(1 / 40, 0, 0, false);
  }
  const total = mod.pathLength(s.points);
  const want = model.lengthOf(s.mass);
  const sp = model.spacingOf(s.mass);
  assert.ok(
    Math.abs(total - want) < sp,
    `body ${total.toFixed(0)} should match ${want.toFixed(0)} (spacing ${sp.toFixed(1)})`,
  );
  assert.ok(s.points.length <= model.maxPointsOf(s.mass), `${s.points.length} points fit the cap`);
  for (let i = 1; i < s.points.length - 1; i++) {
    const a = s.points[i - 1];
    const b = s.points[i];
    const seg = Math.hypot(a.x - b.x, a.y - b.y);
    // Spacing follows mass, and the snake eats as it goes: one percent of slack.
    if (i > 1)
      assert.ok(
        Math.abs(seg - sp) < sp * 0.01,
        `segment ${i} is ${seg.toFixed(2)}, not ${sp.toFixed(2)}`,
      );
  }
});

test("food regrows where it was eaten, so the rim is never richer than the middle", () => {
  const world = new World(true);
  world.host = true;
  const R = model.ARENA_RADIUS;
  const countWithin = (r) =>
    world.foods.filter((f) => f.k === 0 && Math.hypot(f.x, f.y) < r).length;
  const share = (r) => (r * r) / (R * 0.96) ** 2;
  const before = countWithin(2500);
  assert.ok(Math.abs(before / world.foods.length - share(2500)) < 0.03, "starts even");
  // Everyone eats in the middle: strip it bare.
  for (const f of world.foods.slice()) if (Math.hypot(f.x, f.y) < 2500) world.removeFood(f);
  assert.equal(countWithin(2500), 0);
  // Let the world top itself up with nobody around.
  for (let i = 0; i < 400; i++) world.step(1 / 40, 0, 0, false);
  assert.ok(world.foods.length >= model.FOOD_TARGET - 50, `refilled (${world.foods.length})`);
  const after = countWithin(2500);
  const evenShare = share(2500) * world.foods.length;
  assert.ok(
    after > evenShare * 0.85,
    `the eaten middle got its food back: ${after} of an even ${evenShare.toFixed(0)}`,
  );
  // And the outer ring did not swell past its share.
  const rim = world.foods.filter((f) => f.k === 0 && Math.hypot(f.x, f.y) > R * 0.8).length;
  const rimShare = (1 - share(R * 0.8)) * world.foods.length;
  assert.ok(rim < rimShare * 1.15, `rim ${rim} vs even ${rimShare.toFixed(0)}`);
});

test("a bot never boosts or dies on its own: no length cap, no shedding", () => {
  const world = new World(true);
  world.clearFood();
  const bot = world.spawnBot(new Set());
  bot.mass = 6000;
  bot.x = 0;
  bot.y = 0;
  bot.invuln = 0;
  bot.points = [];
  world.ensureTrail(bot);
  // Alone in an empty arena there is nothing to flee, hunt or eat: a giant
  // bot drifts, and never once boosts its length away.
  for (let i = 0; i < 60; i++) {
    world.thinkBot(bot, 0.3);
    assert.equal(bot.boosting, false, `a lone giant bot boosted at decision ${i}`);
  }
});

test("a bold bot cuts across a bigger head it can beat to the crossing point", () => {
  const world = new World(true);
  world.clearFood();
  // A big snake heading east along the x axis, a small bold bot ahead and to its right.
  place(world, "big", 0, 0, 0, 3000);
  const bot = world.spawnBot(new Set());
  bot.mass = 60;
  bot.temper = 1;
  bot.invuln = 0;
  let cut = false;
  for (let i = 0; i < 30 && !cut; i++) {
    bot.x = 200;
    bot.y = -100;
    bot.angle = 0;
    bot.points = [];
    world.ensureTrail(bot);
    world.chooseGoal(bot);
    // Fleeing points away from the head (about -0.5 rad); the crossing point
    // sits just ahead of the head, down and to the right of the bot.
    if (bot.wander > 0.8 && bot.wander < 1.9) cut = true;
  }
  assert.ok(cut, "the bot went for the crossing point");
});
