#!/usr/bin/env node
/**
 * Load the arena with scripted players and read what the server itself
 * measures: `stepMs` (the world step) and `loopMs` (step plus every client's
 * broadcast) from the status endpoint. Players run in a separate process so
 * their own parsing does not sit on the server's thread.
 *
 *   node game-server/scripts/load-test.mjs            # 60, 100 and 150 players
 *   node game-server/scripts/load-test.mjs 40 200     # your own counts
 *
 * Numbers are per core of this machine; a Vercel Sandbox is several times
 * slower, a desktop core about that much faster than the Sandbox.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..");
const PORT = 8390;
const counts = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0);
const runs = counts.length ? counts : [60, 100, 150];

await build({
  entryPoints: [join(root, "dev.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: join(root, "dist", "load-server.mjs"),
  logLevel: "silent",
});
await build({
  entryPoints: [join(here, "load-clients.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: join(root, "dist", "load-clients.mjs"),
  logLevel: "silent",
});

const status = async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/ws`);
  return res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const n of runs) {
  const env = {
    ...process.env,
    PORT: String(PORT),
    GAME_SECRET: "load-test",
    ARENA_CAPACITY: String(n + 10),
  };
  delete env.DATABASE_URL;
  delete env.TURNSTILE_SECRET_KEY;
  delete env.VERCEL;
  const server = spawn("node", [join(root, "dist", "load-server.mjs")], { env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await status()).ok) break;
    } catch {
      /* booting */
    }
    await sleep(200);
  }
  const clients = spawn("node", [join(root, "dist", "load-clients.mjs"), String(PORT), String(n)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  // Let everyone connect and spawn, then sample the loop for a while.
  await sleep(6000);
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const s = await status();
    samples.push(s);
    await sleep(1000);
  }
  const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
  const max = (k) => Math.max(...samples.map((s) => s[k]));
  const last = samples[samples.length - 1];
  console.log(
    `${String(n).padStart(4)} players: clients=${last.clients} snakes=${last.players}+${last.bots} bots  ` +
      `step ${avg("stepMs").toFixed(2)} ms  loop ${avg("loopMs").toFixed(2)} ms (max ${max("loopMs").toFixed(2)})  ` +
      `foods=${last.foods}`,
  );
  clients.kill();
  server.kill();
  await sleep(500);
}
