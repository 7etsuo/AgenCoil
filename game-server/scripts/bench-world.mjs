#!/usr/bin/env node
/**
 * Time the shared simulation step under a few loads. The server's player cap
 * was set against Vercel CPU, which is several times slower than a desktop
 * core, so compare runs against each other rather than against the 25 ms tick.
 *
 *   node game-server/scripts/bench-world.mjs
 *   N=1500 node --cpu-prof game-server/scripts/bench-world.mjs   # then read the profile
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = new URL("../..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "agencoil-bench-"));
const entry = join(dir, "entry.ts");
writeFileSync(
  entry,
  `export * from "${root}src/game/world.ts"; export * as model from "${root}src/game/model.ts";`,
);
const out = join(dir, "world.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out });
const { World } = await import(pathToFileURL(out).href);

function scenario(name, players, bots, crowdR, mass) {
  const w = new World(true);
  w.host = true;
  w.resetLocalBots(bots);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const place = (s) => {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * crowdR;
    s.x = Math.cos(a) * d;
    s.y = Math.sin(a) * d;
    s.points = [];
    w.ensureTrail(s);
  };
  const spawn = (i) => {
    const id = `p${i}`;
    const s = w.spawnSnake(id, id, i % 16, false, undefined, mass * (0.5 + rnd()));
    place(s);
    w.inputs.set(id, { angle: rnd() * Math.PI * 2, boost: false });
    w.lags.set(id, 0.09);
    w.nearIds.add(id);
  };
  for (let i = 0; i < players; i++) spawn(i);
  for (const s of w.snakes) {
    if (!s.isBot) continue;
    s.mass = mass * (0.3 + rnd());
    place(s);
  }
  const dt = 1 / 40;
  const tick = () => {
    for (const inp of w.inputs.values()) if (rnd() < 0.05) inp.angle += rnd() - 0.5;
    w.step(dt, 0, 0, false);
    // Keep the population steady: respawn dead players, regrow shrunken bots.
    for (let i = 0; i < players; i++) if (!w.snakes.some((s) => s.id === `p${i}`)) spawn(i);
    for (const s of w.snakes) {
      if (s.isBot && s.points.length < 12 && s.mass < 40) {
        s.mass = mass * (0.3 + rnd());
        place(s);
      }
    }
  };
  for (let i = 0; i < 120; i++) tick();
  const n = Number(process.env.N ?? 400);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) tick();
  const ms = (performance.now() - t0) / n;
  const pts = w.snakes.reduce((a, s) => a + s.points.length, 0);
  console.log(
    `${name.padEnd(36)} ${ms.toFixed(3)} ms/tick  snakes=${w.snakes.length} points=${pts}`,
  );
}

scenario("spread: 60 players + 50 bots", 60, 50, 6000, 200);
scenario("crowded: 60 players + 50 bots", 60, 50, 2200, 400);
scenario("giants crowded: 40 players + 30 bots", 40, 30, 2500, 3000);
scenario("bots only: 50", 0, 50, 6000, 200);
