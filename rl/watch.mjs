// Watch a trained policy play in the real browser client against an
// in-process arena, and record it. Usage:
//   node rl/watch.mjs rl/runs/first/latest.pt out.mp4 [seconds]
// Needs the Vite dev server dependencies and Playwright's Chromium.
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);
const esbuild = require(join(root, "game-server", "node_modules", "esbuild"));
const { chromium } = require(join(root, "node_modules", "playwright"));
const [ckpt, outFile, secsArg] = process.argv.slice(2);
const seconds = Number(secsArg ?? 40);
if (!ckpt || !outFile) {
  console.error("usage: node rl/watch.mjs <checkpoint.pt> <out.mp4> [seconds]");
  process.exit(1);
}
const work = join(here, "dist", "watch");
mkdirSync(work, { recursive: true });
const weightsPath = join(work, "weights.json");
execFileSync("python3", [join(here, "export.py"), ckpt, weightsPath], { stdio: "inherit" });
await esbuild.build({
  entryPoints: [join(here, "drive.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: join(work, "drive.js"),
  logLevel: "silent",
});
await esbuild.build({
  entryPoints: [join(root, "game-server", "src", "game-server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  // Under game-server/dist so its external imports (ws, pg) resolve from game-server/node_modules.
  outfile: join(root, "game-server", "dist", "watch-server.mjs"),
  logLevel: "silent",
});
const { GameServer } = await import(join(root, "game-server", "dist", "watch-server.mjs"));
delete process.env.DATABASE_URL;
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.VERCEL;
process.env.GAME_SECRET = "watch";
const server = http.createServer();
const game = new GameServer();
game.attach(server);
await new Promise((r) => server.listen(8199, "127.0.0.1", r));
const web = spawn(
  "node",
  [
    "scripts/with-app-env.mjs",
    join(root, "node_modules", ".bin", "vite"),
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    "8198",
    "--strictPort",
  ],
  {
    cwd: root,
    env: { ...process.env, VITE_GAME_SERVER: "ws://127.0.0.1:8199/api/ws" },
    stdio: "ignore",
  },
);
const WEB = "http://127.0.0.1:8198/";
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  try {
    if ((await fetch(WEB)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 300));
}
const browser = await chromium.launch();
const videoDir = join(work, "video");
rmSync(videoDir, { recursive: true, force: true });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 700 },
    recordVideo: { dir: videoDir, size: { width: 1100, height: 700 } },
  });
  const page = await ctx.newPage();
  const weights = readFileSync(weightsPath, "utf8");
  const drive = readFileSync(join(work, "drive.js"), "utf8");
  await page.addInitScript(`window.__coilWeights = ${weights};`);
  await page.addInitScript(drive);
  await page.goto(WEB);
  await page.waitForFunction(() => window.__coil && window.__coil.mode === "online", null, {
    timeout: 30000,
  });
  await page.fill("#nick", "learner");
  await page.click("text=Play");
  await page.waitForFunction(() => window.__coil && window.__coil.phase === "play", null, {
    timeout: 15000,
  });
  const end = Date.now() + seconds * 1000;
  let lives = 0;
  let best = 0;
  while (Date.now() < end) {
    await page.waitForTimeout(500);
    const d = await page.evaluate(() => window.__coil);
    if (d.score > best) best = d.score;
    if (d.phase === "dead") {
      lives++;
      await page.waitForTimeout(1500);
      await page.keyboard.press("Space");
      await page.waitForTimeout(300);
    }
    if (d.phase === "wisp") await page.keyboard.press("Enter");
  }
  console.log(`recorded ${seconds}s: deaths ${lives}, best length ${best}`);
  await ctx.close();
  const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
  const src = join(videoDir, webm);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    src,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "26",
    "-movflags",
    "+faststart",
    outFile,
  ]);
  console.log("wrote", outFile);
} finally {
  await browser.close();
  web.kill();
  game.close();
  server.close();
}
