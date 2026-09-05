import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = require("../game-server/node_modules/esbuild");
const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "agencoil-net-"));
let NetSession, Reader, Writer, S2C, writeSnakeEntry;

before(async () => {
  const entry = join(dir, "entry.ts");
  const out = join(dir, "net.mjs");
  writeFileSync(
    entry,
    `export * from "${root}src/game/net.ts"; export * from "${root}src/game/protocol.ts";`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  ({ NetSession, Reader, Writer, S2C, writeSnakeEntry } = await import(pathToFileURL(out).href));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function session(onLeague = () => {}) {
  return new NetSession("ws://127.0.0.1:8090/api/ws", { onLeague });
}

function welcome(net, instance) {
  net.onMessage(
    new Reader(new Writer().u8(S2C.WELCOME).str(instance).f32(7200).u8(40).u8(5).finish()),
  );
}

test("every reconnect discards food and predictions owned by the previous connection", () => {
  const net = session();
  welcome(net, "arena-one");
  const food = net.world.addFood({ x: 0, y: 0, v: 1, c: 0, r: 4, k: 0 });
  net.pendingEats.set(99, { food: { ...food, id: 99 }, t: 0 });
  net.world.spawnSnake("2", "old remote", 0, false);
  net.buffers.set("2", [{ t: 1 }]);
  net.lastSnapAt = 100;
  welcome(net, "arena-one");
  assert.equal(net.world.foods.length, 0);
  assert.equal(net.world.foodById.size, 0);
  assert.equal(net.pendingEats.size, 0);
  assert.equal(net.world.snakes.length, 0);
  assert.equal(net.buffers.size, 0);
  assert.equal(net.lastSnapAt, 0);
});

test("a reconnect keeps only the local snake until its resume answer arrives", () => {
  const net = session();
  welcome(net, "arena-one");
  const me = net.world.spawnPlayer("1", "me", 0);
  net.selfNid = 1;
  net.world.spawnSnake("2", "remote", 0, false);
  welcome(net, "arena-one");
  assert.deepEqual(net.world.snakes, [me]);
  welcome(net, "arena-two");
  assert.equal(net.world.snakes.length, 0);
});

test("a full remote refresh preserves interpolation and announces its promotion once", () => {
  const promotions = [];
  const net = session((...args) => promotions.push(args));
  welcome(net, "arena-one");
  const remote = net.world.spawnSnake("2", "before", 0, false);
  remote.league = 1;
  const points = remote.points;
  const position = { x: remote.x, y: remote.y };
  const buffer = [
    {
      t: performance.now() - 100,
      ...position,
      angle: 0,
      mass: remote.mass,
      boosting: false,
      invuln: false,
    },
  ];
  net.buffers.set("2", buffer);
  const refresh = () => {
    const w = new Writer().u8(S2C.SNAP).u32(1).u32(0).u16(1);
    writeSnakeEntry(
      w,
      2,
      { ...remote, name: "after", skin: 3, league: 2, x: remote.x + 100 },
      true,
      220,
    );
    w.u8(12).u8(2).u8(4).u8(3).u16(0).u8(0);
    net.onMessage(new Reader(w.finish()));
  };
  refresh();
  assert.equal(net.world.snakes[0], remote);
  assert.equal(remote.points, points);
  assert.equal(remote.x, position.x);
  assert.equal(net.buffers.get("2"), buffer);
  assert.equal(buffer.length, 2);
  assert.equal(remote.name, "after");
  assert.equal(remote.skin, 3);
  assert.equal(remote.level, 12);
  assert.equal(remote.finish, 3);
  assert.deepEqual(promotions, [[2, 1, 2]]);
  refresh();
  assert.deepEqual(promotions, [[2, 1, 2]]);
});

test("truncated length-prefixed text is rejected instead of accepting a partial field", () => {
  const r = new Reader(new Uint8Array([5, 65, 66]));
  assert.throws(() => r.str(), RangeError);
  const valid = new Reader(new Writer().str("🐍 café").u8(42).finish());
  assert.equal(valid.str(), "🐍 café");
  assert.equal(valid.u8(), 42);
  assert.equal(valid.remaining, 0);
});

test("the local snake receives account, crown and appearance changes from snapshots", () => {
  const net = session();
  welcome(net, "arena-one");
  const me = net.world.spawnPlayer("1", "before", 0);
  net.selfNid = 1;
  const w = new Writer().u8(S2C.SNAP).u32(1).u32(0).u16(1);
  writeSnakeEntry(w, 1, { ...me, name: "@after", skin: 3, linked: true, crown: true }, true, 220);
  w.u8(20).u8(3).u8(4).u8(2).u16(0).u8(0);
  net.onMessage(new Reader(w.finish()));
  assert.equal(me.name, "@after");
  assert.equal(me.skin, 3);
  assert.equal(me.level, 20);
  assert.equal(me.linked, true);
  assert.equal(me.crown, true);
  assert.equal(net.world.player, me);
});
