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
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "agencoil-world-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `export * from "${root}src/game/world.ts"; export * as model from "${root}src/game/model.ts";`,
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
  const mod = await import(pathToFileURL(out).href);
  World = mod.World;
  model = mod.model;
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
