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
let level;
let crest;
let record;
let model;
let ProfileStore;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "agencoil-rules-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `export * as rules from "${root}src/game/challenges.ts"; export * as level from "${root}src/game/level.ts"; export * as crest from "${root}src/game/crest.ts"; export * as record from "${root}src/game/record.ts"; export * as model from "${root}src/game/model.ts"; export { ProfileStore } from "${root}game-server/src/profiles.ts";`,
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
  level = mod.level;
  crest = mod.crest;
  record = mod.record;
  model = mod.model;
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
  assert.equal(rules.titleOf({ kills: 0, survive: 0, nearTotal: 0, bountyTotal: 0 }), "");
  assert.equal(rules.titleOf({ kills: 50, survive: 0, nearTotal: 0, bountyTotal: 0 }), "Hunter");
  assert.equal(
    rules.titleOf({ kills: 50, survive: 0, nearTotal: 200, bountyTotal: 0 }),
    "Untouchable",
  );
});

test("every league has its own crest: a distinct shape, letter and colour, drawn inside the unit square", () => {
  const n = rules.LEAGUES.length;
  assert.equal(rules.LEAGUE_SHAPES.length, n);
  assert.equal(rules.LEAGUE_LETTERS.length, n);
  assert.equal(rules.LEAGUE_COLORS.length, n);
  assert.equal(new Set(rules.LEAGUE_SHAPES).size, n, "no two tiers share a shape");
  assert.equal(new Set(rules.LEAGUE_LETTERS).size, n, "no two tiers share a letter");
  assert.equal(new Set(rules.LEAGUE_COLORS).size, n, "no two tiers share a colour");
  assert.equal(crest.crestPolygon("circle"), null);
  assert.equal(crest.crestPolygon("square"), null);
  for (const shape of ["shield", "hexagon", "gem"]) {
    const pts = crest.crestPolygon(shape);
    assert.ok(pts.length >= 5, `${shape} is a polygon`);
    for (const [x, y] of pts) assert.ok(Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5, `${shape} fits`);
    assert.ok(pts[0][1] === -0.5 && pts[1][1] === -0.5, `${shape} has a flat top`);
  }
  // The bottoms differ: the shield and the gem come to a point, the hexagon stays flat.
  assert.equal(crest.crestPolygon("shield").filter(([, y]) => y === 0.5).length, 1);
  assert.equal(crest.crestPolygon("gem").filter(([, y]) => y === 0.5).length, 1);
  assert.equal(crest.crestPolygon("hexagon").filter(([, y]) => y === 0.5).length, 2);
  // And the gem is the only one wider at its girdle than at its top.
  const gem = crest.crestPolygon("gem");
  assert.ok(Math.max(...gem.map(([x]) => x)) > gem[1][0]);
});

test("the exit clocks: midnight, Monday, the boss at :30, and the streak after a life today", () => {
  const t = Date.UTC(2026, 8, 3, 14, 20, 0); // Thursday 3 September 2026
  assert.equal(rules.nextUtcMidnight(t), Date.UTC(2026, 8, 4) - t);
  assert.equal(rules.nextWeekRoll(t), Date.UTC(2026, 8, 7) - t, "Monday the 7th");
  const monday = Date.UTC(2026, 8, 7, 0, 0, 1);
  assert.equal(
    rules.nextWeekRoll(monday),
    Date.UTC(2026, 8, 14) - monday,
    "a Monday counts to the next",
  );
  assert.notEqual(
    rules.isoWeek(new Date(Date.UTC(2026, 8, 6))),
    rules.isoWeek(new Date(Date.UTC(2026, 8, 7))),
    "the roll and isoWeek agree that Monday starts a week",
  );
  assert.deepEqual(model.nextBossAt(t), { inMs: 10 * 60_000, up: false });
  assert.deepEqual(model.nextBossAt(Date.UTC(2026, 8, 3, 14, 32)), { inMs: 0, up: true });
  assert.equal(model.nextBossAt(Date.UTC(2026, 8, 3, 14, 40)).inMs, 50 * 60_000);
  const next = (streak, last, freezes) => rules.nextStreak(streak, last, freezes, "2026-09-03");
  assert.deepEqual(next(4, "2026-09-02", 0), { streak: 5, playedToday: false, usesFreeze: false });
  assert.deepEqual(next(4, "2026-09-01", 1), { streak: 5, playedToday: false, usesFreeze: true });
  assert.deepEqual(next(4, "2026-09-01", 0), { streak: 1, playedToday: false, usesFreeze: false });
  assert.deepEqual(next(4, "2026-09-03", 0), { streak: 4, playedToday: true, usesFreeze: false });
  assert.deepEqual(next(0, "", 0), { streak: 1, playedToday: false, usesFreeze: false });
});

test("a record is measured against the best at spawn, above a floor, never from a life that starts past it", () => {
  assert.equal(record.recordTarget(540, 100, 10), 540);
  assert.equal(record.recordTarget(100, 540, 10), 540, "the best kept in the browser counts too");
  assert.equal(record.recordTarget(40, 0, 10), 0, "under the floor there is no moment");
  assert.equal(record.recordTarget(120, 0, 130), 0, "a comeback past the record passes nothing");
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

test("the coordinator picks the party's arena, else the oldest with room, else the newest", async () => {
  const { mkdirSync: mk } = await import("node:fs");
  const outDir = join(root, "game-server", "node_modules", ".cache");
  mk(outDir, { recursive: true });
  const out = join(outDir, "agencoil-arena.test.mjs");
  await esbuild.build({
    entryPoints: [join(root, "game-server", "src", "arena-host.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["pg", "@vercel/sandbox"],
    outfile: out,
    logLevel: "silent",
  });
  const { pickArena } = await import(pathToFileURL(out).href);
  const ok = (players) => ({ ok: true, players, at: 0 });
  const arenas = [
    { name: "a", domain: "https://a", createdAt: 1, expiresAt: 9, health: ok(60) },
    { name: "b", domain: "https://b", createdAt: 2, expiresAt: 9, health: ok(3) },
    {
      name: "c",
      domain: "https://c",
      createdAt: 3,
      expiresAt: 9,
      health: { ok: false, players: 0, at: 0 },
    },
  ];
  assert.equal(pickArena(arenas, null, 60).name, "b", "oldest arena with room");
  assert.equal(pickArena(arenas, "a", 60).name, "a", "party sticks to its arena even when full");
  assert.equal(pickArena(arenas, "c", 60).name, "b", "a dead party arena is ignored");
  assert.equal(pickArena([arenas[0]], null, 60).name, "a", "everything full: the newest live one");
  assert.equal(pickArena([arenas[2]], null, 60), null, "nothing live");
});

test("static arenas are placed on, never rolled or forgotten, and absorb a stale sandbox", async () => {
  const { mkdirSync: mk } = await import("node:fs");
  const outDir = join(root, "game-server", "node_modules", ".cache");
  mk(outDir, { recursive: true });
  const out = join(outDir, "agencoil-arena-tick.test.mjs");
  await esbuild.build({
    entryPoints: [join(root, "game-server", "src", "arena-host.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["pg", "@vercel/sandbox"],
    outfile: out,
    logLevel: "silent",
  });
  const { ArenaHost, STATIC_BUILD } = await import(pathToFileURL(out).href);
  const now = Date.now();
  const far = Date.UTC(2100, 0, 1);
  const rows = [
    {
      name: "home-1",
      domain: "https://home1",
      created_at: 1,
      expires_at: far,
      build: STATIC_BUILD,
    },
    {
      name: "snek-arena-old",
      domain: "https://old",
      created_at: now - 3600_000,
      expires_at: now + 20 * 3600_000,
      build: "dpl_old",
    },
  ];
  const deleted = [];
  const pool = {
    query: async (text) => {
      if (text.includes("FROM agencoil_arena WHERE expires_at"))
        return { rows, rowCount: rows.length };
      if (text.startsWith("DELETE FROM agencoil_arena WHERE name")) {
        deleted.push(text);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const health = {
    "https://home1": { ok: true, players: 4 },
    "https://old": { ok: true, players: 2 },
  };
  const drained = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/drain")) {
      drained.push(u);
      return new Response("{}", { status: 200 });
    }
    const base = u.replace(/\/api\/ws$/, "");
    return new Response(JSON.stringify(health[base] ?? { ok: false }), { status: 200 });
  };
  try {
    const host = new ArenaHost(pool, {
      VERCEL: "1",
      GAME_SECRET: "s",
      VERCEL_DEPLOYMENT_ID: "dpl_new",
    });
    assert.equal(host.enabled, true);
    // resolve() also kicks a background tick once a minute; keep the test deterministic.
    host.lastTick = Date.now();
    // Placement prefers the static arena (created first, has room).
    const pick = await host.resolve("");
    assert.equal(pick.name, "home-1");
    // The stale sandbox drains into the healthy static arena; no successor is made.
    const t1 = await host.tick();
    assert.deepEqual(t1.drained, ["snek-arena-old"]);
    assert.equal(t1.created, false);
    assert.ok(drained[0].startsWith("https://old/"), "drain went to the sandbox");
    assert.equal(deleted.length, 1, "only the sandbox row was removed");
    // A static arena that is down is skipped by placement but its row survives.
    health["https://home1"] = { ok: false };
    rows.splice(1, 1, {
      name: "snek-arena-new",
      domain: "https://new",
      created_at: now,
      expires_at: now + 20 * 3600_000,
      build: "dpl_new",
    });
    health["https://new"] = { ok: true, players: 1 };
    const host2 = new ArenaHost(pool, {
      VERCEL: "1",
      GAME_SECRET: "s",
      VERCEL_DEPLOYMENT_ID: "dpl_new",
    });
    host2.lastTick = Date.now();
    const t2 = await host2.tick();
    assert.equal(deleted.length, 1, "the static row is never deleted");
    assert.deepEqual(t2.drained, []);
    assert.equal(
      (await host2.resolve("")).name,
      "snek-arena-new",
      "players go to the live sandbox meanwhile",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a lookup that finds only a booting arena waits for it instead of starting another", async () => {
  const { mkdirSync: mk } = await import("node:fs");
  const outDir = join(root, "game-server", "node_modules", ".cache");
  mk(outDir, { recursive: true });
  const out = join(outDir, "agencoil-arena-boot.test.mjs");
  await esbuild.build({
    entryPoints: [join(root, "game-server", "src", "arena-host.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["pg", "@vercel/sandbox"],
    outfile: out,
    logLevel: "silent",
  });
  const { ArenaHost } = await import(pathToFileURL(out).href);
  const now = Date.now();
  const rows = [
    {
      name: "snek-arena-young",
      domain: "https://young",
      created_at: now - 5000,
      expires_at: now + 22 * 3600_000,
      build: "dpl_new",
    },
  ];
  let leaseTries = 0;
  const pool = {
    query: async (text) => {
      if (text.includes("FROM agencoil_arena WHERE expires_at"))
        return { rows, rowCount: rows.length };
      if (text.includes("agencoil_arena_lock SET until = $1")) {
        leaseTries++;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  let probes = 0;
  const realFetch = globalThis.fetch;
  // The young arena fails its first two probes (a cold Sandbox), then answers.
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith("https://young/")) return new Response("{}", { status: 404 });
    probes++;
    return probes < 3
      ? new Response("", { status: 503 })
      : new Response(JSON.stringify({ ok: true, players: 0 }), { status: 200 });
  };
  try {
    const env = { VERCEL: "1", GAME_SECRET: "s", VERCEL_DEPLOYMENT_ID: "dpl_new" };
    const host = new ArenaHost(pool, env);
    host.lastTick = Date.now();
    const pick = await host.resolve("");
    assert.equal(pick.name, "snek-arena-young", "the young arena is waited for");
    assert.ok(probes >= 3, `probed until it answered (${probes})`);
    assert.equal(leaseTries, 0, "no second arena was started");
    // Still silent after the wait: the player is sent there anyway and will ask again.
    globalThis.fetch = async () => new Response("", { status: 503 });
    const host2 = new ArenaHost(pool, env);
    host2.lastTick = Date.now();
    const again = await host2.resolve("");
    assert.equal(again.name, "snek-arena-young");
    assert.equal(leaseTries, 0, "and still no second arena");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a tick that finds several stale arenas starts one successor, not one each", async () => {
  const { mkdirSync: mk } = await import("node:fs");
  const outDir = join(root, "game-server", "node_modules", ".cache");
  mk(outDir, { recursive: true });
  const out = join(outDir, "agencoil-arena-roll.test.mjs");
  await esbuild.build({
    entryPoints: [join(root, "game-server", "src", "arena-host.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["pg", "@vercel/sandbox"],
    outfile: out,
    logLevel: "silent",
  });
  const { ArenaHost } = await import(pathToFileURL(out).href);
  const now = Date.now();
  const rows = ["one", "two"].map((n, i) => ({
    name: `snek-arena-${n}`,
    domain: `https://${n}`,
    created_at: now - 3600_000 + i,
    expires_at: now + 20 * 3600_000,
    build: "dpl_old",
  }));
  const pool = {
    query: async (text) =>
      text.includes("FROM agencoil_arena WHERE expires_at")
        ? { rows, rowCount: rows.length }
        : { rows: [], rowCount: 0 },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, players: 1 }), { status: 200 });
  try {
    const host = new ArenaHost(pool, {
      VERCEL: "1",
      GAME_SECRET: "s",
      VERCEL_DEPLOYMENT_ID: "dpl_new",
    });
    let creations = 0;
    host.createArena = async () => {
      creations++;
      return true;
    };
    const t = await host.tick();
    assert.equal(t.created, true);
    assert.equal(creations, 1, "both stale arenas share one successor");
    assert.deepEqual(t.drained, [], "they drain once it is up, on a later tick");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a drained arena's Sandbox is stopped, and a tick stops running arena Sandboxes with no row", async () => {
  const { mkdirSync: mk } = await import("node:fs");
  const outDir = join(root, "game-server", "node_modules", ".cache");
  mk(outDir, { recursive: true });
  const out = join(outDir, "agencoil-arena-sweep.test.mjs");
  await esbuild.build({
    entryPoints: [join(root, "game-server", "src", "arena-host.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["pg", "@vercel/sandbox"],
    outfile: out,
    logLevel: "silent",
  });
  const { ArenaHost } = await import(pathToFileURL(out).href);
  const now = Date.now();
  // An old arena on the previous deploy and its healthy successor on this one.
  const rows = [
    {
      name: "snek-arena-old",
      domain: "https://old",
      created_at: now - 3600_000,
      expires_at: now + 20 * 3600_000,
      build: "dpl_old",
    },
    {
      name: "snek-arena-new",
      domain: "https://new",
      created_at: now - 600_000,
      expires_at: now + 22 * 3600_000,
      build: "dpl_new",
    },
  ];
  const pool = {
    query: async (text) =>
      text.includes("FROM agencoil_arena WHERE expires_at")
        ? { rows, rowCount: rows.length }
        : { rows: [], rowCount: 0 },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, players: 0 }), { status: 200 });
  const stopped = [];
  const sandboxes = {
    stop: async (name) => {
      stopped.push(name);
    },
    // What the Sandbox API lists as running: both rows, a leftover from an
    // earlier roll, a create still in progress, and something else entirely.
    running: async () => [
      { name: "snek-arena-old", createdAt: now - 3600_000 },
      { name: "snek-arena-new", createdAt: now - 600_000 },
      { name: "snek-arena-leftover", createdAt: now - 2 * 3600_000 },
      { name: "snek-arena-booting", createdAt: now - 20_000 },
      { name: "other-sandbox", createdAt: now - 3600_000 },
    ],
  };
  try {
    const host = new ArenaHost(
      pool,
      { VERCEL: "1", GAME_SECRET: "s", VERCEL_DEPLOYMENT_ID: "dpl_new" },
      sandboxes,
    );
    const t = await host.tick();
    assert.deepEqual(t.drained, ["snek-arena-old"], "the stale arena drained into its successor");
    assert.ok(stopped.includes("snek-arena-old"), "the drained arena's Sandbox was stopped");
    assert.ok(stopped.includes("snek-arena-leftover"), "a running arena with no row was stopped");
    assert.ok(!stopped.includes("snek-arena-new"), "the live arena keeps running");
    assert.ok(!stopped.includes("snek-arena-booting"), "a young Sandbox is left to finish booting");
    assert.ok(!stopped.includes("other-sandbox"), "nothing outside the arena prefix is touched");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ticks closer than fifteen seconds answer with the last result", async () => {
  const { mkdirSync: mk } = await import("node:fs");
  const outDir = join(root, "game-server", "node_modules", ".cache");
  mk(outDir, { recursive: true });
  const out = join(outDir, "agencoil-arena-throttle.test.mjs");
  await esbuild.build({
    entryPoints: [join(root, "game-server", "src", "arena-host.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["pg", "@vercel/sandbox"],
    outfile: out,
    logLevel: "silent",
  });
  const { ArenaHost } = await import(pathToFileURL(out).href);
  let reads = 0;
  const pool = {
    query: async (text) => {
      if (text.includes("FROM agencoil_arena WHERE expires_at")) {
        reads++;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const host = new ArenaHost(pool, { VERCEL: "1", GAME_SECRET: "s", VERCEL_DEPLOYMENT_ID: "d" });
  host.createArena = async () => false;
  const first = await host.tick();
  const second = await host.tick();
  assert.equal(second, first, "the same answer, no second read");
  assert.equal(reads, 1);
});

test("league tiers are shares of the season's field, with the fixed ladder for a small field", () => {
  const field = Array.from({ length: 100 }, (_, i) => (i + 1) * 100);
  const c = rules.cutoffsFrom(field);
  assert.equal(c[0], 0, "Bronze is everyone");
  assert.ok(c[1] >= 3400 && c[1] <= 3700, `Silver starts at the 35th percentile (${c[1]})`);
  assert.ok(c[2] >= 6400 && c[2] <= 6700, `Gold at the 65th (${c[2]})`);
  assert.ok(c[3] >= 8400 && c[3] <= 8600, `Platinum at the 85th (${c[3]})`);
  assert.ok(c[4] >= 9400 && c[4] <= 9600, `Diamond at the 95th (${c[4]})`);
  assert.equal(rules.leagueOf(10000, c), 4);
  assert.equal(rules.leagueOf(5000, c), 1);
  // A small field: every tier is at least three players wide.
  const small = rules.cutoffsFrom(Array.from({ length: 20 }, (_, i) => (i + 1) * 100));
  assert.equal(rules.leagueOf(1800, small), 4, "the top three are Diamond");
  assert.ok(rules.leagueOf(1700, small) < 4, "the fourth is not");
  assert.equal(rules.leagueOf(1500, small), 3, "the next three Platinum");
  assert.equal(rules.leagueOf(5000), 4, "on the fixed ladder 5000 is Diamond");
  assert.deepEqual(
    [...rules.cutoffsFrom([50, 60, 70])],
    [...rules.DEFAULT_CUTOFFS],
    "too few players",
  );
  const flat = rules.cutoffsFrom(Array(30).fill(10));
  for (let i = 1; i < flat.length; i++)
    assert.ok(flat[i] > flat[i - 1], "a flat field still has five tiers");
});

test("league stakes: three runs bank a tier, and each tier's payout is fixed", () => {
  assert.equal(rules.bankedTierOf([0, 0, 0, 0, 0]), 0);
  assert.equal(rules.bankedTierOf([3, 2, 0, 0, 0]), 1, "Bronze after three lives of any length");
  assert.equal(rules.bankedTierOf([5, 3, 3, 1, 0]), 3, "Gold with three Gold-length lives");
  assert.equal(rules.bankedTierOf([3, 3, 3, 3, 3]), 5);
  assert.equal(rules.LEAGUE_BANK_RUNS, 3);
  assert.equal(rules.LEAGUE_REWARDS.length, rules.LEAGUES.length);
  assert.equal(rules.rewardText(1), "nothing", "Bronze pays nothing");
  assert.match(rules.rewardText(3), /chest/);
  assert.match(rules.rewardText(3), /gold aura/);
  assert.match(rules.rewardText(5), /2 chests/);
  assert.equal(
    rules.titleOf({ kills: 0, survive: 0, nearTotal: 0, bountyTotal: 0, seasons: [[2, 4]] }),
    "Platinum S2",
  );
  assert.equal(
    rules.titleOf({ kills: 0, survive: 0, nearTotal: 0, bountyTotal: 0, seasons: [[2, 3]] }),
    "",
    "Gold and below do not title",
  );
});

test("the character level climbs an MMO table: cheap early, dear late, capped at 60", () => {
  assert.equal(level.LEVEL_CAP, 60);
  assert.deepEqual([1, 2, 3, 4, 5, 10].map(level.xpToNext), [100, 348, 722, 1213, 1812, 6310]);
  assert.equal(level.xpToNext(60), 0, "nothing past the cap");
  assert.ok(level.xpToNext(59) > 150_000 && level.xpToNext(59) < 160_000);
  assert.ok(
    level.XP_MAX > 3_300_000 && level.XP_MAX < 3_350_000,
    `about 3.3 million to the cap (${level.XP_MAX})`,
  );
  assert.equal(level.xpForLevel(1), 0);
  assert.equal(level.xpForLevel(2), 100);
  assert.equal(level.xpForLevel(3), 448);
  assert.equal(level.levelOf(0), 1, "everyone starts at 1");
  assert.equal(level.levelOf(99), 1);
  assert.equal(level.levelOf(100), 2);
  assert.equal(level.levelOf(447), 2);
  assert.equal(level.levelOf(448), 3);
  assert.equal(level.levelOf(level.XP_MAX - 1), 59);
  assert.equal(level.levelOf(level.XP_MAX), 60);
  assert.equal(level.levelOf(level.XP_MAX * 10), 60);
  assert.deepEqual(level.xpInto(150), { level: 2, into: 50, next: 348 });
  assert.deepEqual(level.xpInto(level.XP_MAX + 5), { level: 60, into: 5, next: 0 });
});

test("growth pays on a concave curve, so one life can never jump levels", () => {
  assert.equal(level.growthXp(150), 101);
  assert.equal(level.growthXp(2000), 478);
  assert.ok(level.growthXp(20000) > 1890 && level.growthXp(20000) < 1910);
  assert.ok(level.growthXp(200000) > 7560 && level.growthXp(200000) < 7590);
  let prev = 0;
  for (let g = 0; g <= 250_000; g += 500) {
    const v = level.growthXp(g);
    assert.ok(v >= prev, "never pays less for more");
    prev = v;
  }
  assert.ok(
    level.growthXp(20000) - level.growthXp(10000) < level.growthXp(10000) - level.growthXp(0),
    "each further ten thousand pays less than the last",
  );
  // A single 69,000 life with nineteen kills from a fresh profile: level 6, not 15.
  assert.equal(level.levelOf(level.growthXp(69018) + 19 * level.killXp(200)), 6);
  assert.equal(level.killXp(0), 25);
  assert.equal(level.killXp(400), 65);
  assert.equal(level.killXp(2500), 125, "capped");
  assert.equal(level.killXp(1_000_000), 125);
  // Rested: a share of the level per hour away, at most one level, none at the cap.
  assert.equal(level.restedFor(10, 3), 946);
  assert.equal(level.restedFor(1, 4), 20);
  assert.equal(level.restedFor(1, 400), 100);
  assert.equal(level.restedFor(60, 400), 0);
  assert.equal(level.scalesForLevel(42), 67);
  assert.equal(level.lifeScales({ length: 2010, kills: 1, contracts: 0, marks: 0 }), 50);
});

test("the seed puts today's board where the plan says and never at the cap", () => {
  const owner = { games: 908, eaten: 10_858_260, kills: 1543, achievements: 10, chests: 2 };
  assert.equal(level.levelOf(level.seedXp(owner)), 43);
  assert.equal(
    level.levelOf(
      level.seedXp({ games: 74, eaten: 540_822, kills: 187, achievements: 5, chests: 1 }),
    ),
    16,
  );
  assert.equal(
    level.levelOf(
      level.seedXp({ games: 185, eaten: 1_459_026, kills: 512, achievements: 6, chests: 1 }),
    ),
    22,
  );
  assert.equal(level.seedXp({ games: 0, eaten: 0, kills: 0, achievements: 0, chests: 0 }), 0);
  assert.equal(
    level.seedXp({ games: 1_000_000, eaten: 1e12, kills: 1e6, achievements: 0, chests: 0 }),
    level.XP_MAX,
  );
});

test("the store books experience through the rested pool, stops at the cap, and pays the track once", async () => {
  const store = new ProfileStore();
  const p = await store.load("dev-xp", "grinder");
  assert.equal(p.xp, 0);
  assert.equal(p.trackClaimed, 1, "level 1 is the start, not a reward");
  let r = store.addXp(p, 500);
  assert.deepEqual(r, { gained: 500, bonus: 0, from: 1, to: 3 });
  assert.equal(store.claimTrack(p), 27 + 28, "levels 2 and 3 pay 25 plus the level");
  assert.equal(store.claimTrack(p), 0, "paid once");
  assert.equal(p.scales, 55);
  // Away for four hours at level 3 (722 to the next): 5% an hour rested.
  p.seen = Date.now() - 4 * 3600_000;
  assert.equal(store.touchRested(p), Math.floor(4 * 0.05 * 722));
  const pool = p.rested;
  r = store.addXp(p, 50);
  assert.deepEqual(r, { gained: 100, bonus: 50, from: 3, to: 3 }, "rested doubles what comes in");
  assert.equal(p.rested, pool - 50);
  // Never seen before: nothing to accrue. At the cap: nothing either.
  const fresh = await store.load("dev-xp-2", "new");
  assert.equal(store.touchRested(fresh), 0);
  fresh.xp = level.XP_MAX - 10;
  r = store.addXp(fresh, 1000);
  assert.deepEqual(r, { gained: 10, bonus: 0, from: 59, to: 60 });
  fresh.seen = Date.now() - 100 * 3600_000;
  assert.equal(store.touchRested(fresh), 0);
  assert.equal(level.levelOf(fresh.xp), 60);
});
