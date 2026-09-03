// Shared helpers for the end-to-end suite: boots the arena server and the
// Vite dev server on private ports, and exposes a Playwright browser.
import { spawn } from "node:child_process";
import { chromium } from "playwright";

export const GAME_PORT = 8199;
export const WEB_PORT = 8198;
export const WEB = `http://127.0.0.1:${WEB_PORT}/`;
export const GAME_WS = `ws://127.0.0.1:${GAME_PORT}/api/ws`;

const root = new URL("..", import.meta.url).pathname;

async function waitFor(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

/** Start a game server on GAME_PORT (or another port) with a fixed secret. */
export function startGame(port = GAME_PORT) {
  const child = spawn("node", ["dist/dev.mjs"], {
    cwd: `${root}game-server`,
    env: { ...process.env, PORT: String(port), GAME_SECRET: "e2e-secret" },
    stdio: "ignore",
  });
  return child;
}

export async function startAll() {
  await new Promise((resolve, reject) => {
    const b = spawn("npm", ["run", "bundle"], { cwd: `${root}game-server`, stdio: "ignore" });
    b.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("bundle failed"))));
  });
  const gameRef = { current: startGame() };
  const web = spawn(
    "node",
    [
      "scripts/with-app-env.mjs",
      `${root}node_modules/.bin/vite`,
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(WEB_PORT),
      "--strictPort",
    ],
    { cwd: root, env: { ...process.env, VITE_GAME_SERVER: GAME_WS }, stdio: "ignore" },
  );
  await waitFor(`http://127.0.0.1:${GAME_PORT}/api/ws`, 20000);
  await waitFor(WEB, 60000);
  const browser = await chromium.launch();
  return {
    browser,
    game: gameRef,
    async stop() {
      await browser.close();
      gameRef.current.kill();
      web.kill();
    },
  };
}

export async function openPlayer(browser, name, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport ?? { width: 1100, height: 700 },
    deviceScaleFactor: 1,
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(opts.url ?? WEB, { waitUntil: "load" });
  await page.waitForTimeout(500);
  await page.fill("#nick", name);
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(1200);
  return { page, ctx, errors, dbg: () => page.evaluate(() => window.__coil) };
}

export async function steer(page, secs, fn = (t) => [400 + t * 30, 350]) {
  for (let t = 0; t < secs; t++) {
    const [x, y] = fn(t);
    await page.mouse.move(x, y);
    await page.waitForTimeout(1000);
  }
}
