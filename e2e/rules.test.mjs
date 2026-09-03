// Retention rules that live outside the simulation: streaks with freezes,
// leagues, evolution levels, titles, the hourly mode clock and seasons.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("../game-server/node_modules/esbuild");
const root = new URL("..", import.meta.url).pathname;

let rules;
let ProfileStore;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "agencoil-rules-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `export * as rules from "${root}src/game/challenges.ts"; export { ProfileStore } from "${root}game-server/src/profiles.ts";`,
  );
  // Emitted under the server's node_modules so the external "pg" resolves.
  const outDir = join(root, "game-server", "node_modules", ".cache");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, "agencoil-rules.test.mjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["pg"],
    outfile: out,
    logLevel: "silent",
  });
  delete process.env.DATABASE_URL;
  const mod = await import(pathToFileURL(out).href);
  rules = mod.rules;
  ProfileStore = mod.ProfileStore;
});

const life = (length, extra = {}) => ({
  length,
  kills: 0,
  survive: 30,
  near: 0,
  remains: 0,
  noboostLength: 0,
  bounty: 0,
  ...extra,
});

test("leagues, levels and titles follow the documented thresholds", () => {
  assert.equal(rules.LEAGUES[rules.leagueOf(0)].name, "Bronze");
  assert.equal(rules.LEAGUES[rules.leagueOf(299)].name, "Bronze");
  assert.equal(rules.LEAGUES[rules.leagueOf(300)].name, "Silver");
  assert.equal(rules.LEAGUES[rules.leagueOf(3000)].name, "Diamond");
  assert.equal(rules.levelOf(0), 0);
  assert.equal(rules.levelOf(300), 1);
  assert.equal(rules.levelOf(300 * 25), 5);
  assert.equal(rules.titleOf({ kills: 0, survive: 0, nearTotal: 0, bountyTotal: 0 }), "");
  assert.equal(rules.titleOf({ kills: 50, survive: 0, nearTotal: 0, bountyTotal: 0 }), "Hunter");
  assert.equal(
    rules.titleOf({ kills: 50, survive: 0, nearTotal: 200, bountyTotal: 0 }),
    "Untouchable",
  );
});

test("a named mode runs for the first 15 minutes of every hour", () => {
  const hour = Date.UTC(2026, 8, 3, 14, 0, 0);
  const on = rules.modeNow(hour + 5 * 60_000);
  assert.ok(on.id > 0, "active inside the window");
  assert.equal(on.secsLeft, 10 * 60);
  const off = rules.modeNow(hour + 20 * 60_000);
  assert.equal(off.id, 0);
  assert.equal(off.secsToNext, 40 * 60);
  const ids = new Set();
  for (let h = 0; h < rules.MODES.length; h++)
    ids.add(rules.modeNow(hour + h * 3_600_000 + 60_000).id);
  assert.equal(ids.size, rules.MODES.length, "every mode gets its own hour");
  assert.ok(!rules.MODES.some((m) => m.id === 2), "the no-boost mode is gone");
});

test("seasons are six weeks long", () => {
  const start = Date.UTC(2026, 8, 7);
  assert.equal(rules.seasonOf(start), rules.seasonOf(start + 41 * 86_400_000));
  assert.equal(rules.seasonOf(start) + 1, rules.seasonOf(start + 42 * 86_400_000));
});

test("streaks survive one missed day with a freeze, and milestones unlock cosmetics", async () => {
  const store = new ProfileStore();
  const p = await store.load("dev-1", "tester");
  // recordLife rolls the profile to today, so the streak is driven by moving
  // streakLast backwards between lives instead of moving the clock forward.
  const realToday = new Date().toISOString().slice(0, 10);
  p.day = realToday;
  store.recordLife(p, life(40));
  assert.equal(p.streak, 1);
  assert.equal(p.streakLast, realToday);
  // Simulate three consecutive days by rewriting streakLast to "yesterday".
  const shift = (days) => {
    const d = new Date(Date.parse(p.streakLast + "T00:00:00Z") - days * 86_400_000);
    p.streakLast = d.toISOString().slice(0, 10);
  };
  shift(1);
  store.recordLife(p, life(40));
  assert.equal(p.streak, 2, "consecutive day extends the streak");
  shift(2);
  assert.equal(p.freezes, 0);
  store.recordLife(p, life(40));
  assert.equal(p.streak, 1, "a two-day gap with no freeze restarts");
  // Five games earn one freeze; the profile has played 3 so far.
  store.recordLife(p, life(40));
  store.recordLife(p, life(40));
  assert.equal(p.games, 5);
  assert.equal(p.freezes, 1, "one freeze banked after five games");
  shift(2);
  store.recordLife(p, life(40));
  assert.equal(p.streak, 2, "the freeze bridged a one-day miss");
  assert.equal(p.freezes, 0, "and was consumed");
  shift(1);
  store.recordLife(p, life(40));
  assert.equal(p.streak, 3);
  assert.ok(p.unlocks & 32, "three-day milestone unlocks the frost trail");
});

test("lifetime totals feed levels and season bests", async () => {
  const store = new ProfileStore();
  const p = await store.load("dev-2", "tester");
  store.recordLife(p, life(610, { near: 3, bounty: 2 }));
  assert.equal(p.eaten, 600, "eaten counts growth beyond the starting length");
  assert.equal(rules.levelOf(p.eaten), 1);
  assert.equal(p.nearTotal, 3);
  assert.equal(p.bountyTotal, 2);
  assert.equal(p.seasonBest, 610);
  assert.equal(p.season, rules.seasonOf());
});

test("quests are a chain: only the active step progresses, and the chain opens a chest", async () => {
  const store = new ProfileStore();
  const p = await store.load("dev-3", "tester");
  assert.equal(p.shards, 1, "a new profile starts with one shard");
  const chain = rules.dailyChallenges(p.day);
  const bigLife = {
    length: 5000,
    kills: 50,
    survive: 5000,
    near: 500,
    remains: 5000,
    noboostLength: 5000,
    bounty: 5,
  };
  const r1 = store.recordLife(p, bigLife);
  assert.equal(r1.completed.length, 1, "one step per life at most");
  assert.equal(p.done[0], true);
  assert.ok(!p.done[1], "step two did not take the same life");
  assert.equal(r1.chest, false);
  store.recordLife(p, bigLife);
  const r3 = store.recordLife(p, bigLife);
  assert.equal(p.done[2], true);
  assert.equal(r3.chest, true, `finishing step ${chain.length} opens a chest`);
  const before = p.unlocks;
  const msg1 = store.openChest(p);
  assert.match(msg1, /shard 2\/3/);
  const msg2 = store.openChest(p);
  assert.match(msg2, /unlocked/);
  assert.equal(p.shards, 0);
  assert.ok(p.unlocks !== before, "three shards unlocked a cosmetic");
});
