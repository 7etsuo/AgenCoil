import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import WebSocket from "ws";
import type { GameServer as GameServerT } from "./game-server.ts";
import type * as ProtocolT from "../../src/game/protocol.ts";

// The server and the shared protocol use extensionless imports, which the
// type stripper cannot resolve, so both are bundled the way the build does.
const root = new URL("../", import.meta.url).pathname;
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });
const entry = join(outDir, `game-server.test-entry-${process.pid}.ts`);
const out = join(outDir, `game-server.test-${process.pid}.mjs`);
writeFileSync(
  entry,
  `export { GameServer } from "${root}src/game-server.ts";\n` +
    `export * as protocol from "${root}../src/game/protocol.ts";\n`,
);
buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: out,
  logLevel: "silent",
});
const { GameServer, protocol } = (await import(pathToFileURL(out).href)) as {
  GameServer: typeof GameServerT;
  protocol: typeof ProtocolT;
};
rmSync(out, { force: true });
rmSync(entry, { force: true });
const { C2S, S2C, Reader, Writer, writeBands } = protocol;

// No database, no Turnstile: a bare arena with a fixed signing secret.
delete process.env.DATABASE_URL;
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.VERCEL;
process.env.GAME_SECRET = "test-secret";

interface Arena {
  game: GameServerT;
  url: string;
  stop(): Promise<void>;
}

async function startArena(): Promise<Arena> {
  const server = http.createServer();
  const game = new GameServer();
  game.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    game,
    url: `ws://127.0.0.1:${port}/api/ws?v=2`,
    async stop() {
      game.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A client socket with a queue of decoded messages to wait on by type. */
class Player {
  private readonly queue: Uint8Array[] = [];
  private waiters: (() => void)[] = [];
  readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.on("message", (data) => {
      this.queue.push(new Uint8Array(data as ArrayBuffer));
      const w = this.waiters;
      this.waiters = [];
      for (const fn of w) fn();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  /** The next message of one type, its type byte already consumed. */
  async next(type: number, timeoutMs = 3000): Promise<InstanceType<typeof Reader>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.queue.findIndex((m) => m[0] === type);
      if (i >= 0) {
        const [m] = this.queue.splice(i, 1);
        const r = new Reader(m!);
        r.u8();
        return r;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for message type ${type}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, left);
      });
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

function ident(key: string, name: string): Uint8Array {
  return new Writer().u8(C2S.IDENT).str(key).str(name).finish();
}

/** A v2 HELLO (or SPAWN) with the same tail the browser client sends. */
function hello(name: string, key: string, token = "", respawn = false): Uint8Array {
  const w = new Writer()
    .u8(respawn ? C2S.SPAWN : C2S.HELLO)
    .str(name)
    .u8(0);
  writeBands(w, undefined);
  w.str(respawn ? "" : token)
    .str(key)
    .u8(0)
    .str("")
    .u8(0)
    .str("")
    .u16(0)
    .str("")
    .str("");
  return w.finish();
}

async function joinArena(url: string, key: string, name: string, token = ""): Promise<Player> {
  const p = new Player(url);
  await p.open();
  p.send(ident(key, name));
  await p.next(S2C.PROFILE);
  p.send(hello(name, key, token));
  await p.next(S2C.SPAWNED);
  return p;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a reconnect that reattaches the held snake keeps the crew tag", async () => {
  const arena = await startArena();
  try {
    const first = new Player(arena.url);
    await first.open();
    first.send(ident("dev-crew", "tester"));
    await first.next(S2C.PROFILE);
    first.send(new Writer().u8(C2S.CREW).str("ACE").finish());
    await first.next(S2C.PROFILE);
    first.send(hello("tester", "dev-crew"));
    const spawned = await first.next(S2C.SPAWNED);
    const nid = spawned.u16();
    const token = (await first.next(S2C.TOKEN)).str();
    const before = arena.game.world.snakes.find((s) => !s.isBot);
    assert.ok(before, "the player has a snake");
    assert.equal(before.name, "[ACE] tester");
    // The socket drops; the snake is held for a grace period.
    await first.close();
    await sleep(50);
    assert.ok(arena.game.world.snakes.some((s) => s.id === before.id && s.alive));

    const second = new Player(arena.url);
    await second.open();
    second.send(ident("dev-crew", "tester"));
    await second.next(S2C.PROFILE);
    second.send(hello("tester", "dev-crew", token));
    const again = await second.next(S2C.SPAWNED);
    assert.equal(again.u16(), nid, "same snake, same nid");
    const players = arena.game.world.snakes.filter((s) => !s.isBot);
    assert.equal(players.length, 1, "the held snake was reattached, not duplicated");
    assert.equal(players[0]!.id, before.id);
    assert.equal(players[0]!.name, "[ACE] tester", "the crew tag survives the reconnect");
    await second.close();
  } finally {
    await arena.stop();
  }
});

test("a snake killed after its socket left leaves no per-snake state behind", async () => {
  const arena = await startArena();
  try {
    const p = await joinArena(arena.url, "dev-gone", "leaver");
    const me = arena.game.world.snakes.find((s) => !s.isBot);
    assert.ok(me);
    assert.ok(arena.game.world.nearIds.has(me.id));
    assert.ok(arena.game.world.inputs.has(me.id));
    await p.close();
    await sleep(50);
    // What the grace timer would do, without waiting it out.
    arena.game.world.killSnake(me.id);
    await sleep(150);
    assert.ok(!arena.game.world.snakes.some((s) => s.id === me.id));
    assert.ok(!arena.game.world.inputs.has(me.id), "input entry dropped");
    assert.ok(!arena.game.world.nearIds.has(me.id), "near-miss entry dropped");
    // A death between ticks is still a death: the run reaches today's board.
    const daily = arena.game.status().daily as { name: string; best: number }[];
    assert.ok(
      daily.some((e) => e.name === "leaver"),
      `the abandoned run is on the daily board: ${JSON.stringify(daily)}`,
    );
  } finally {
    await arena.stop();
  }
});

test("a resume token is single use", async () => {
  const arena = await startArena();
  try {
    const first = await joinArena(arena.url, "dev-token", "once");
    const token = (await first.next(S2C.TOKEN)).str();
    await first.close();
    const second = await joinArena(arena.url, "dev-token", "once", token);
    const third = await joinArena(arena.url, "dev-token", "once", token);
    const players = arena.game.world.snakes.filter((s) => !s.isBot && s.alive);
    // The second socket reattached; the third presented a spent token and
    // spawned fresh, while the second socket's snake stays alive.
    assert.equal(players.length, 2);
    await second.close();
    await third.close();
  } finally {
    await arena.stop();
  }
});

test("a death between ticks still starts a wisp that follows the input", async () => {
  const arena = await startArena();
  try {
    const p = await joinArena(arena.url, "dev-wisp", "ghost");
    const me = arena.game.world.snakes.find((s) => !s.isBot);
    assert.ok(me);
    arena.game.world.killSnake(me.id);
    const first = await p.next(S2C.WISP);
    const x0 = first.f32();
    first.f32();
    assert.ok(first.u16() === 0 && first.u8() > 0, "a fresh wisp with time left");
    // Steer east for a while and watch the server's wisp go that way.
    const input = new Writer()
      .u8(C2S.INPUT)
      .u16(1)
      .angle(0)
      .u8(0)
      .f32(0)
      .f32(0)
      .f32(900)
      .f32(600)
      .u8(0)
      .finish();
    for (let i = 0; i < 6; i++) {
      p.send(input);
      await sleep(50);
    }
    let x1 = x0;
    for (;;) {
      const r = await p.next(S2C.WISP, 500).catch(() => null);
      if (!r) break;
      x1 = r.f32();
    }
    assert.ok(x1 > x0 + 40, `the wisp moved east (${x0.toFixed(0)} -> ${x1.toFixed(0)})`);
    await p.close();
  } finally {
    await arena.stop();
  }
});

test("food sync keeps a client's orbs exactly equal to the server's orbs in its view", async () => {
  const arena = await startArena();
  try {
    const p = await joinArena(arena.url, "dev-food", "eater");
    const game = arena.game as unknown as {
      clients: Set<{ view: { cx: number; cy: number; hw: number; hh: number } }>;
      sendFood(c: unknown): void;
      stopLoop(): void;
    };
    const client = [...game.clients][0]!;
    const held = new Set<number>();
    const dels: number[] = [];
    p.ws.on("message", (data) => {
      const r = new Reader(new Uint8Array(data as ArrayBuffer));
      const type = r.u8();
      if (type === S2C.FOOD_ADD) {
        const n = r.u16();
        for (let i = 0; i < n; i++) {
          const f = protocol.readFood(r);
          assert.ok(!held.has(f.id!), `orb ${f.id} added twice`);
          held.add(f.id!);
        }
      } else if (type === S2C.FOOD_DEL) {
        const n = r.u16();
        for (let i = 0; i < n; i++) {
          const id = r.u32();
          assert.ok(held.has(id), `orb ${id} deleted but never held`);
          held.delete(id);
          dels.push(id);
        }
      }
    });
    // Freeze the world so the comparison is exact, then drive syncs by hand.
    game.stopLoop();
    await sleep(60);
    const world = arena.game.world;
    const expected = (): Set<number> => {
      const v = client.view;
      const pad = 220 + 96;
      const out = new Set<number>();
      world.forEachFoodIn(
        v.cx - v.hw - pad,
        v.cy - v.hh - pad,
        v.cx + v.hw + pad,
        v.cy + v.hh + pad,
        (f) => out.add(f.id!),
      );
      return out;
    };
    const same = (label: string) => {
      const want = expected();
      const missing = [...want].filter((id) => !held.has(id)).length;
      const extra = [...held].filter((id) => !want.has(id)).length;
      assert.equal(
        missing + extra,
        0,
        `${label}: missing ${missing}, extra ${extra} of ${want.size}`,
      );
    };
    const sync = async () => {
      game.sendFood(client);
      await sleep(80);
    };
    const view = (cx: number, cy: number) => {
      client.view = { cx, cy, hw: 900, hh: 600 };
    };
    view(0, 0);
    await sync();
    assert.ok(held.size > 50, `the view holds orbs (${held.size})`);
    same("first sync");
    await sync();
    same("a second sync with nothing changed");
    // The view moves: what left is dropped, what entered is added.
    view(1200, 300);
    await sync();
    same("after moving the view");
    // Orbs eaten, spawned, and moved within the view.
    const inView = [...held].map((id) => world.foodById.get(id)!).filter(Boolean);
    world.removeFood(inView[0]!);
    world.removeFood(inView[1]!);
    world.addFood({ x: 1250, y: 320, v: 1, c: 0, r: 4, k: 0 });
    const mover = inView[2]!;
    const before = dels.length;
    world.moveFood(mover, mover.x + 200, mover.y);
    await sync();
    same("after eats, a spawn and a move");
    assert.ok(
      !dels.slice(before).includes(mover.id!),
      "an orb moving within the view is not resent",
    );
    // An orb moved out of the view is dropped; one moved in is added.
    const leaver = [...held].map((id) => world.foodById.get(id)!).filter(Boolean)[0]!;
    world.moveFood(leaver, leaver.x + 5000, leaver.y);
    const far = world.foods.find((f) => Math.abs(f.x - 1200) > 3000)!;
    world.moveFood(far, 1200, 300);
    await sync();
    same("after orbs cross the view edge");
    assert.ok(!held.has(leaver.id!) && held.has(far.id!));
    await p.close();
  } finally {
    await arena.stop();
  }
});

/** Parse one SNAP end to end for a protocol version; throws or leaves bytes on a layout mismatch. */
function parseSnap(r: InstanceType<typeof Reader>, proto: number) {
  r.u32();
  r.u32();
  const n = r.u16();
  const entries: {
    nid: number;
    full: boolean;
    level: number;
    league: number;
    might: number;
    finish: number;
  }[] = [];
  for (let i = 0; i < n; i++) {
    const e = protocol.readSnakeEntry(r);
    const level = e.full && proto >= 2 ? r.u8() : 0;
    const league = e.full && proto >= 3 ? r.u8() : 0;
    const might = e.full && proto >= 3 ? r.u8() : 0;
    const finish = e.full && proto >= 4 ? r.u8() : 0;
    entries.push({ nid: e.nid, full: e.full, level, league, might, finish });
  }
  const gone = r.u16();
  for (let i = 0; i < gone; i++) r.u16();
  const chase = r.u8();
  for (let i = 0; i < chase; i++) {
    r.u32();
    r.f32();
    r.f32();
  }
  assert.equal(r.remaining, 0, `protocol ${proto}: snapshot fully consumed`);
  return entries;
}

/** Parse a PROFILE message the way the client does; leaves nothing over on a matching layout. */
function parseProfile(r: InstanceType<typeof Reader>) {
  const out: Record<string, unknown> = {};
  out.best = r.u32();
  r.u32();
  r.u32();
  r.u32();
  r.u32();
  r.u32();
  r.u8();
  r.f32();
  r.f32();
  r.u8();
  r.u8();
  out.weekBest = r.u32();
  r.u16();
  r.u8();
  out.prevTier = r.u8();
  r.u32();
  r.u32();
  r.u16();
  r.u32();
  r.u16();
  r.u8();
  r.str();
  r.u16();
  r.u16();
  r.str();
  r.u8();
  r.str();
  out.bankedTier = r.u8();
  out.weekLives = r.u8();
  out.weekRuns = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
  out.seasonTier = r.u8();
  out.seasons = r.str();
  assert.equal(r.remaining, 0, "profile fully consumed");
  return out;
}

test("protocol 4 full entries carry league, might and finish; older protocols keep their layouts", async () => {
  const arena = await startArena();
  try {
    for (const proto of [2, 3, 4]) {
      const url = arena.url.replace(/v=2$/, `v=${proto}`);
      const p = new Player(url);
      await p.open();
      assert.equal((await p.next(S2C.WELCOME)).str() && 1, 1);
      p.send(ident(`dev-proto-${proto}`, `p${proto}`));
      await p.next(S2C.PROFILE);
      p.send(hello(`p${proto}`, `dev-proto-${proto}`));
      const nid = (await p.next(S2C.SPAWNED)).u16();
      const entries = parseSnap(await p.next(S2C.SNAP), proto);
      const me = entries.find((e) => e.nid === nid);
      assert.ok(me && me.full, "the first snapshot carries our own full entry");
      if (proto >= 3) {
        assert.equal(me.league, 1, "a fresh profile is Bronze");
        assert.equal(me.might, 0, "and has unlocked nothing yet");
        assert.equal(me.finish, 0, "and no finish from last week");
        const bot = entries.find((e) => e.nid !== nid && e.full);
        if (bot) assert.equal(bot.league, 0, "bots have no league");
      }
      // A board row per client protocol: 3 adds a league byte after the bounty.
      const stats = await p.next(S2C.STATS2, 2000);
      stats.f32();
      stats.u16();
      stats.u16();
      stats.u16();
      stats.u16();
      const nb = stats.u8();
      for (let i = 0; i < nb; i++) {
        stats.u16();
        stats.str();
        stats.u32();
        stats.f32();
        stats.f32();
        stats.u32();
        if (proto >= 3) assert.ok(stats.u8() <= 5, "league byte in range");
      }
      const nd = stats.u8();
      for (let i = 0; i < nd; i++) {
        stats.str();
        stats.u32();
      }
      const np = stats.u8();
      for (let i = 0; i < np; i++) {
        stats.str();
        stats.u32();
      }
      stats.u8();
      stats.u16();
      stats.u16();
      stats.u8();
      stats.f32();
      stats.f32();
      assert.equal(stats.remaining, 0, `protocol ${proto}: stats fully consumed`);
      const profile = parseProfile(await p.next(S2C.PROFILE));
      assert.equal(profile.bankedTier, 0);
      assert.deepEqual(profile.weekRuns, [0, 0, 0, 0, 0]);
      await p.close();
    }
  } finally {
    await arena.stop();
  }
});

test("crossing a league length mid-life is announced and changes the ring for everyone", async () => {
  const arena = await startArena();
  try {
    const url4 = arena.url.replace(/v=2$/, "v=4");
    const watcher = await joinArena(url4, "dev-watch", "watcher");
    const p = await joinArena(url4, "dev-climb", "climber");
    const me = arena.game.world.snakes.find((s) => s.name === "climber");
    assert.ok(me);
    // Point the watcher's view at the climber so it holds the climber's entry.
    watcher.send(
      new Writer()
        .u8(C2S.INPUT)
        .u16(1)
        .angle(0)
        .u8(0)
        .f32(me.x)
        .f32(me.y)
        .f32(900)
        .f32(600)
        .u8(0)
        .finish(),
    );
    await sleep(300);
    me.mass = 350;
    const notice = await (async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const r = await p.next(S2C.NOTICE, 1500);
        r.u8();
        const text = r.str();
        if (/reached Silver/.test(text)) return text;
      }
      throw new Error("no promotion notice");
    })();
    assert.match(notice, /1\/3 to bank Silver/);
    assert.equal(me.league, 2, "the snake's league byte rose");
    // The watcher gets a fresh full entry for the climber with the new league.
    const deadline = Date.now() + 3000;
    let seen = false;
    while (!seen && Date.now() < deadline) {
      const entries = parseSnap(await watcher.next(S2C.SNAP, 1500), 4);
      const e = entries.find((x) => x.full && x.league === 2);
      if (e) seen = true;
    }
    assert.ok(seen, "a full entry with league 2 reached the other client");
    await p.close();
    await watcher.close();
  } finally {
    await arena.stop();
  }
});
