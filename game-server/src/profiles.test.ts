import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { ACHIEVEMENTS, lifeFeats, nextSteps, totalsUnlocked } from "../../src/game/achievements.ts";
import type { ProfileStore as ProfileStoreT } from "./profiles.ts";

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
