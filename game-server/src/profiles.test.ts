import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import type pg from "pg";
import {
  ACHIEVEMENTS,
  MIGHT_PIPS,
  lifeFeats,
  mightPips,
  nextSteps,
  totalsUnlocked,
} from "../../src/game/achievements.ts";
import type { ProfileStore as ProfileStoreT } from "./profiles.ts";
import { LEAGUE_BANK_RUNS, LEAGUES, titleOf } from "../../src/game/challenges.ts";

// profiles.ts uses extensionless imports, which the type stripper cannot
// resolve, so bundle it the way the server build does.
// The bundle lives under dist/ so its external imports (pg) resolve from node_modules.
const outDir = new URL("../dist/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `profiles.test-${process.pid}.mjs`);
buildSync({
  entryPoints: [new URL("./profiles.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: out,
  logLevel: "silent",
});
const { ProfileStore } = (await import(pathToFileURL(out).href)) as {
  ProfileStore: typeof ProfileStoreT;
};
rmSync(out, { force: true });

const id = { sub: "u1", handle: "tetsuo", name: "Tetsuo", avatar: "" };

test("signing in adopts the device profile and keeps its history", async () => {
  const store = new ProfileStore();
  const device = await store.load("dev-abc", "coil42");
  device.best = 640;
  device.games = 12;
  const p = await store.link(device, id, "Tetsuo");
  assert.equal(p.key, "acct:u1");
  assert.equal(p.best, 640);
  assert.equal(p.handle, "tetsuo");
  assert.equal(p.sub, "u1");
  // The same account from another device lands on the same profile.
  const other = await store.load("dev-xyz", "anon");
  const again = await store.link(other, id, "Tetsuo");
  assert.equal(again, p);
  assert.equal(await store.byHandle("tetsuo"), p);
});

test("concurrent loads of one key share a single profile object", async () => {
  // A database that answers a moment later, so two loads overlap in flight.
  const pool = {
    query: () => new Promise((resolve) => setTimeout(() => resolve({ rows: [], rowCount: 0 }), 5)),
  } as unknown as pg.Pool;
  const store = new ProfileStore(pool);
  const [a, b] = await Promise.all([store.load("same-key", "a"), store.load("same-key", "b")]);
  assert.equal(a, b, "two sockets asking at once must not get two copies");
  assert.equal(await store.load("same-key", "c"), a);
});

test("a fresh device with no history does not take over an account", async () => {
  const store = new ProfileStore();
  const first = await store.link(await store.load("d1", "a"), id, "a");
  first.best = 900;
  const empty = await store.load("d2", "b");
  const p = await store.link(empty, id, "b");
  assert.equal(p, first);
  assert.equal(p.best, 900);
});

test("two accounts wanting one handle get distinct handles", async () => {
  const store = new ProfileStore();
  const a = await store.link(null, id, "a");
  const b = await store.link(null, { ...id, sub: "u2" }, "b");
  assert.equal(a.handle, "tetsuo");
  assert.equal(b.handle, "tetsuo_2");
});

test("achievements are awarded once and milestones follow the totals", async () => {
  const store = new ProfileStore();
  const p = await store.load("d", "x");
  assert.equal(store.award(p, "linked"), true);
  assert.equal(store.award(p, "linked"), false);
  p.kills = 12;
  p.best = 350;
  const earned = store.awardTotals(p);
  assert.deepEqual(earned.sort(), ["big_1", "big_2", "first_blood", "hunter_1"]);
  assert.deepEqual(store.awardTotals(p), []);
  assert.ok(Object.keys(p.achv).every((k) => ACHIEVEMENTS.some((a) => a.id === k)));
});

test("feats read a single life; next steps point at the nearest milestone", () => {
  assert.deepEqual(
    lifeFeats({
      length: 520,
      kills: 0,
      survive: 30,
      near: 0,
      remains: 0,
      noboostLength: 310,
      bounty: 0,
    }),
    ["pacifist", "purist"],
  );
  assert.deepEqual(
    lifeFeats({
      length: 50,
      kills: 10,
      survive: 950,
      near: 0,
      remains: 600,
      noboostLength: 0,
      bounty: 0,
    }),
    ["pentakill", "rampage", "scavenger", "marathon"],
  );
  const t = {
    best: 90,
    kills: 9,
    games: 1,
    survive: 10,
    eaten: 0,
    nearTotal: 0,
    bountyTotal: 0,
    streak: 0,
    chests: 0,
  };
  const steps = nextSteps(t, new Set(totalsUnlocked(t)), 2);
  assert.equal(steps[0]!.a.id, "hunter_1");
  assert.equal(steps[0]!.have, 9);
  assert.equal(steps[1]!.a.id, "big_1");
});

test("might pips: none at zero, one for the first unlock, all five at the full set", () => {
  assert.equal(mightPips(0), 0);
  assert.equal(mightPips(1), 1);
  assert.equal(mightPips(ACHIEVEMENTS.length), MIGHT_PIPS);
  assert.equal(mightPips(ACHIEVEMENTS.length * 2), MIGHT_PIPS);
  let last = 0;
  for (let n = 0; n <= ACHIEVEMENTS.length; n++) {
    const pips = mightPips(n);
    assert.ok(pips >= last, "pips never fall as achievements grow");
    last = pips;
  }
});

const lifeOf = (length: number) => ({
  length,
  kills: 0,
  survive: 30,
  near: 0,
  remains: 0,
  noboostLength: 0,
  bounty: 0,
});

test("a tier is banked after three lives at its length, not one lucky run", async () => {
  const store = new ProfileStore();
  const p = await store.load("bank-1", "x");
  let r = store.recordLife(p, lifeOf(3000));
  assert.equal(r.banked, 0, "one Diamond run banks nothing on its own");
  assert.equal(p.bankedTier, 0);
  store.recordLife(p, lifeOf(350));
  r = store.recordLife(p, lifeOf(360));
  assert.equal(r.banked, 2, "three lives at Silver length bank Silver (the big run counts too)");
  assert.equal(p.bankedTier, 2);
  assert.deepEqual(p.weekRuns, [3, 3, 1, 1, 1]);
  assert.equal(p.weekLives, 3);
  assert.equal(p.seasonTier, 2);
  store.recordLife(p, lifeOf(900));
  r = store.recordLife(p, lifeOf(850));
  assert.equal(r.banked, 3, "the third Gold-length life banks Gold");
  assert.equal(store.bankFeat(p, 3), "league_gold");
  assert.equal(store.bankFeat(p, 3), null, "the feat is given once");
  // Falling short later never takes a banked tier away.
  r = store.recordLife(p, lifeOf(20));
  assert.equal(r.banked, 0);
  assert.equal(p.bankedTier, 3);
});

test("the week roll pays the banked tier, queues the notice and keeps the season's best", async () => {
  const store = new ProfileStore();
  const p = await store.load("bank-2", "x");
  for (let i = 0; i < LEAGUE_BANK_RUNS; i++) store.recordLife(p, lifeOf(1600));
  assert.equal(p.bankedTier, 4, "Platinum");
  const chestsBefore = p.chests;
  const shardsBefore = p.shards;
  p.week = "2020-W01";
  store.challenges(p); // rolls the week
  assert.equal(p.prevTier, 4, "the finish is what was banked");
  assert.equal(p.chests, chestsBefore + 1, "Platinum pays a chest");
  // The chest's shard and the reward shard: a full set unlocks a cosmetic.
  assert.ok(p.shards !== shardsBefore || p.unlocks !== 0, "and a shard");
  assert.equal(p.pending.length, 1);
  assert.match(p.pending[0]!, /Platinum/);
  assert.deepEqual(p.weekRuns, [0, 0, 0, 0, 0]);
  assert.equal(p.bankedTier, 0);
  assert.equal(p.weekLives, 0);
  assert.equal(p.seasonTier, 4, "the season keeps the best banked tier");
  const drained = store.drainPending(p);
  assert.equal(drained.lines.length, 1);
  assert.deepEqual(store.drainPending(p), { lines: [], achv: [] }, "drained once");
});

test("a week with lives but nothing banked says so; a week with no lives says nothing", async () => {
  const store = new ProfileStore();
  const p = await store.load("bank-3", "x");
  store.recordLife(p, lifeOf(5000));
  p.week = "2020-W01";
  store.challenges(p);
  assert.equal(p.prevTier, 0);
  assert.match(p.pending[0]!, /no tier/);
  store.drainPending(p);
  p.week = "2020-W02";
  store.challenges(p);
  assert.equal(p.pending.length, 0);
});

test("the season roll writes the best banked tier into history, permanently, with its feats", async () => {
  const store = new ProfileStore();
  const p = await store.load("bank-4", "x");
  for (let i = 0; i < LEAGUE_BANK_RUNS; i++) store.recordLife(p, lifeOf(3200));
  assert.equal(p.seasonTier, 5);
  const thisSeason = p.season;
  p.season = 41;
  store.challenges(p); // rolls the season
  assert.deepEqual(p.seasons, [[41, 5]]);
  assert.equal(p.season, thisSeason);
  assert.equal(p.seasonTier, 0);
  assert.ok(p.achv.season_gold && p.achv.season_diamond, "season feats awarded");
  const drained = store.drainPending(p);
  assert.ok(drained.lines.some((l) => /season 41/.test(l)));
  assert.deepEqual(drained.achv.sort(), ["season_diamond", "season_gold"]);
  assert.equal(
    titleOf({ kills: 999, survive: 0, nearTotal: 0, bountyTotal: 9, seasons: p.seasons }),
    "Diamond S41",
    "a season finish outranks the lifetime titles",
  );
  assert.equal(LEAGUES[4]!.name, "Diamond");
  const pub = store.publicProfile(p, 1);
  assert.deepEqual(pub.seasons, [[41, 5]]);
});
