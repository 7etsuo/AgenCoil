import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_BUFFER_MAX, EventLog, ensureEventsTable, runMetrics } from "./events.ts";
import type { Queryable } from "./events.ts";

test("without a database the log is a no-op", () => {
  const log = new EventLog(null, "test");
  log.log("spawn", { key: "k" });
  assert.equal(log.enabled, false);
  assert.equal(log.buffered, 0);
});

test("a flush writes every buffered event in one statement, arrays aligned", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool: Queryable = {
    query: async (text, params = []) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  let t = 1_000_000;
  const log = new EventLog(pool, "arena-1", () => (t += 1000));
  log.log("session_start", { key: "a", meta: { proto: 4 } });
  log.log("death", { key: "a", s: "player", n: 120, meta: { survive: 33 } });
  log.log("feature", { s: "chest" });
  assert.equal(log.buffered, 3);
  await log.flush();
  assert.equal(log.buffered, 0);
  const insert = calls.find((c) => c.text.includes("INSERT INTO agencoil_events"));
  assert.ok(insert, "one insert");
  assert.equal(calls.filter((c) => c.text.includes("INSERT INTO")).length, 1);
  const [ats, arenas, kinds, keys, ss, ns, metas] = insert.params as string[][];
  assert.deepEqual(kinds, ["session_start", "death", "feature"]);
  assert.deepEqual(keys, ["a", "a", ""]);
  assert.deepEqual(ss, ["", "player", "chest"]);
  assert.deepEqual(ns, [0, 120, 0]);
  assert.deepEqual(arenas, ["arena-1", "arena-1", "arena-1"]);
  assert.equal(ats!.length, 3);
  assert.deepEqual(JSON.parse(metas![0]!), { proto: 4 });
});

test("a failed flush keeps the rows for the next try; a full buffer drops the oldest", async () => {
  let fail = true;
  const pool: Queryable = {
    query: async (text) => {
      if (fail && text.includes("INSERT INTO")) throw new Error("db down");
      return { rows: [] };
    },
  };
  const log = new EventLog(pool, "a");
  log.log("spawn", { key: "k" });
  await log.flush();
  assert.equal(log.buffered, 1, "kept after a failure");
  fail = false;
  await log.flush();
  assert.equal(log.buffered, 0);
  for (let i = 0; i < EVENT_BUFFER_MAX + 10; i++) log.log("feature", { s: String(i) });
  assert.equal(log.buffered, EVENT_BUFFER_MAX);
  assert.equal(log.dropped, 10);
});

test("the metrics queries run on real Postgres and answer the retention questions", async () => {
  const { PGlite } = (await import("../../node_modules/@electric-sql/pglite/dist/index.js")) as {
    PGlite: new () => Queryable & { close(): Promise<void> };
  };
  const db = new PGlite();
  try {
    await ensureEventsTable(db);
    const day = 86_400_000;
    const now = Date.now();
    const log = new EventLog(db, "arena-1");
    // Player a: seen three days ago and again two days ago (a D1 return); one
    // session of 90 s with two lives, one death to a player and one to the rim.
    log.log("session_start", { key: "a", meta: { proto: 4 } }, now - 3 * day);
    log.log("spawn", { key: "a", s: "fresh", n: 10 }, now - 3 * day + 1000);
    log.log(
      "death",
      { key: "a", s: "player", n: 200, meta: { survive: 40 } },
      now - 3 * day + 41_000,
    );
    log.log("spawn", { key: "a", s: "comeback", n: 50 }, now - 3 * day + 42_000);
    log.log("death", { key: "a", s: "wall", n: 80, meta: { survive: 20 } }, now - 3 * day + 62_000);
    log.log("session_end", { key: "a", n: 90, meta: { lives: 2 } }, now - 3 * day + 90_000);
    log.log("session_start", { key: "a" }, now - 2 * day);
    log.log("session_end", { key: "a", n: 30, meta: { lives: 1 } }, now - 2 * day + 30_000);
    log.log("feature", { key: "a", s: "chest" }, now - 2 * day + 1000);
    // Player b: seen once, yesterday, never came back.
    log.log("session_start", { key: "b" }, now - day);
    log.log("session_end", { key: "b", n: 300, meta: { lives: 3 } }, now - day + 300_000);
    await log.flush();
    assert.equal(log.buffered, 0);

    const m = await runMetrics(db, 7);
    assert.equal(m.daily.length, 3, "three distinct days");
    assert.equal(m.daily[0]!.players, 1);
    assert.equal(m.daily[0]!.newPlayers, 1);
    assert.equal(m.daily[0]!.sessions, 1);
    assert.equal(m.daily[0]!.lives, 2);
    assert.equal(m.daily[1]!.newPlayers, 0, "a returning player is not new");
    assert.equal(m.retention.cohort, 2);
    assert.equal(m.retention.d1, 1, "a came back the next day, b did not");
    assert.equal(m.retention.d1Eligible, 2);
    assert.equal(m.retention.d7, 0);
    assert.equal(m.sessions.count, 3);
    assert.equal(Math.round(m.sessions.medianSecs), 90);
    assert.equal(m.sessions.livesPerSession, 2);
    const byCause = Object.fromEntries(m.deaths.map((d) => [d.cause, d]));
    assert.equal(byCause.player!.count, 1);
    assert.equal(byCause.player!.meanLength, 200);
    assert.equal(byCause.wall!.meanSurvive, 20);
    assert.deepEqual(m.spawns.map((x) => x.kind).sort(), ["comeback", "fresh"]);
    assert.deepEqual(m.features, [{ name: "chest", count: 1 }]);
    // A read through the cached, instance-level API agrees.
    const again = await log.metrics(7);
    assert.equal(again?.retention.cohort, 2);
  } finally {
    await db.close();
  }
});
