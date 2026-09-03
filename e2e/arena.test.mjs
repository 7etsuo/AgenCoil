import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startAll, openPlayer, steer, startGame, GAME_PORT } from "./helpers.mjs";

let env;
before(async () => {
  env = await startAll();
});
after(async () => {
  await env.stop();
});

test("the body follows the head (trail is recorded)", async () => {
  const p = await openPlayer(env.browser, "trail");
  await steer(p.page, 3);
  const d = await p.dbg();
  assert.equal(d.mode, "online");
  assert.ok(d.playerPts > 10, `expected a trail, got ${d.playerPts} points`);
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test("two players share one server instance and see the same arena", async () => {
  const a = await openPlayer(env.browser, "alpha");
  const b = await openPlayer(env.browser, "bravo");
  await steer(a.page, 3);
  const da = await a.dbg();
  const db = await b.dbg();
  assert.equal(da.mode, "online");
  assert.equal(db.mode, "online");
  assert.equal(da.instance, db.instance);
  assert.equal(da.players, 2);
  assert.ok(da.snakes >= 1 && db.snakes >= 1);
  await a.ctx.close();
  await b.ctx.close();
});

test("a reload resumes the same snake with its length", async () => {
  const p = await openPlayer(env.browser, "resume");
  await steer(p.page, 4);
  const before = await p.dbg();
  await p.page.reload({ waitUntil: "load" });
  await p.page.waitForTimeout(400);
  await p.page.fill("#nick", "resume");
  await p.page.getByRole("button", { name: "Play" }).click();
  await p.page.waitForTimeout(1500);
  const after = await p.dbg();
  assert.equal(after.mode, "online");
  assert.equal(after.phase, "play");
  assert.ok(Math.abs(after.score - before.score) < 12, `length ${before.score} -> ${after.score}`);
  await p.ctx.close();
});

test("a replaced server instance rebuilds the snake from the resume token", async () => {
  const p = await openPlayer(env.browser, "hopper");
  await steer(p.page, 3);
  const before = await p.dbg();
  env.game.current.kill();
  await p.page.waitForTimeout(600);
  env.game.current = startGame(GAME_PORT);
  let after = null;
  for (let t = 0; t < 12; t++) {
    await p.page.mouse.move(500 + t * 10, 350);
    await p.page.waitForTimeout(1000);
    after = await p.dbg();
    if (
      after.mode === "online" &&
      after.instance !== before.instance &&
      after.phase === "play" &&
      after.score > 0
    )
      break;
  }
  assert.equal(after.mode, "online");
  assert.notEqual(after.instance, before.instance);
  assert.equal(after.phase, "play");
  assert.ok(Math.abs(after.score - before.score) < 15, `length ${before.score} -> ${after.score}`);
  await p.ctx.close();
});

test("without a server the game falls back to the offline arena", async () => {
  const ctx = await env.browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:8198/`, { waitUntil: "load" });
  await page.evaluate(() => {
    // Simulate a dead server: close the socket and block reconnects.
    const orig = window.WebSocket;
    window.WebSocket = class extends orig {
      constructor(_url) {
        super("ws://127.0.0.1:1/dead");
      }
    };
  });
  await page.waitForTimeout(500);
  await page.fill("#nick", "offline");
  await page.getByRole("button", { name: "Play" }).click();
  let d = null;
  for (let t = 0; t < 12; t++) {
    await page.waitForTimeout(1000);
    d = await page.evaluate(() => window.__coil);
    if (d.phase === "play" && d.playerPts > 0 && d.snakes > 5) break;
  }
  assert.equal(d.phase, "play");
  assert.ok(d.snakes > 5, "local bots should populate the arena");
  await ctx.close();
});

test("a throttled phone keeps a playable frame rate", async () => {
  const p = await openPlayer(env.browser, "phone", {
    viewport: { width: 390, height: 844 },
    mobile: true,
  });
  const cdp = await p.ctx.newCDPSession(p.page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const fps = [];
  for (let t = 0; t < 6; t++) {
    await p.page.touchscreen.tap(200 + Math.cos(t) * 80, 500 + Math.sin(t) * 80);
    await p.page.waitForTimeout(1000);
    fps.push((await p.dbg()).fps);
  }
  const min = Math.min(...fps.slice(1));
  assert.ok(min >= 40, `min fps ${min} (${fps.join(" ")})`);
  await p.ctx.close();
});

test("server status reports bots, players and death heat", async () => {
  const res = await fetch(`http://127.0.0.1:${GAME_PORT}/api/ws`).then((r) => r.json());
  assert.equal(res.ok, true);
  assert.ok(res.bots >= 30);
  assert.ok(Array.isArray(res.hot));
  const pkg = JSON.parse(
    readFileSync(new URL("../game-server/package.json", import.meta.url), "utf8"),
  );
  assert.ok(pkg.scripts.bundle);
});
