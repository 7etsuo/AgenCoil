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
import { growthXp, killXp, levelOf, xpForLevel } from "../../src/game/level.ts";
import { cosmeticIndex, dropPool } from "../../src/game/cosmetics.ts";

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
    `export * as protocol from "${root}../src/game/protocol.ts";\n` +
    `export { mintAgentPass, checkAgentPass } from "${root}src/agent-pass.ts";\n`,
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
const { GameServer, protocol, mintAgentPass, checkAgentPass } = (await import(
  pathToFileURL(out).href
)) as {
  GameServer: typeof GameServerT;
  mintAgentPass: (secret: string, now?: number) => string;
  checkAgentPass: (pass: string | null, secret: string, now?: number) => boolean;
  protocol: typeof ProtocolT;
};
rmSync(out, { force: true });
rmSync(entry, { force: true });
const { C2S, S2C, Reader, Writer, writeBands } = protocol;

// No database, no Turnstile: a bare arena with a fixed signing secret.
delete process.env.DATABASE_URL;
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.VERCEL;
delete process.env.AGENT_SECRET;
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

  /** Forget every queued message of one type, so the next one is fresh. */
  drain(type: number): void {
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.queue[i]![0] === type) this.queue.splice(i, 1);
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

/** An introduction carrying the site's origin and account ticket. */
function identWith(key: string, name: string, origin: string, ticket: string): Uint8Array {
  return new Writer().u8(C2S.IDENT).str(key).str(name).str(origin).str(ticket).finish();
}

function handleMsg(raw: string): Uint8Array {
  return new Writer().u8(C2S.HANDLE).str(raw).finish();
}

/** A stand-in for the site: redeems any ticket as one fixed account. */
async function fakeSite(
  sub: string,
  handle: string,
  name: string,
): Promise<{ origin: string; close(): Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://site");
    if (url.pathname === "/api/identity/redeem" && url.searchParams.get("t")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, sub, handle, name, avatar: "" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
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

test("a life ended by a lost connection is still booked on the profile", async () => {
  const arena = await startArena();
  try {
    const p = await joinArena(arena.url, "dev-left", "leaver");
    const me = arena.game.world.snakes.find((s) => !s.isBot);
    assert.ok(me);
    me.mass = 777;
    me.kills = 2;
    await p.close();
    await sleep(50);
    // What the grace timer would do, without waiting it out.
    arena.game.world.killSnake(me.id);
    await sleep(150);
    // The next session on the same device sees the run it walked away from.
    const again = new Player(arena.url);
    await again.open();
    again.send(ident("dev-left", "leaver"));
    const profile = parseProfile(await again.next(S2C.PROFILE));
    // The snake keeps moving in its grace window and may eat a stray orb, so a few units of drift are fine.
    const best = Number(profile.best);
    assert.ok(best >= 777 && best < 800, `the best length of the abandoned run (${best})`);
    assert.equal(profile.weekBest, profile.best);
    assert.equal(profile.weekLives, 1, "the life counts");
    assert.deepEqual(profile.weekRuns, [1, 1, 0, 0, 0], "and it was a Silver run");
    await again.close();
  } finally {
    await arena.stop();
  }
});

test("a reconnect that reattaches the held snake carries its life on", async () => {
  const arena = await startArena();
  try {
    const game = arena.game as unknown as { clients: Set<{ life: { startAt: number } | null }> };
    const first = await joinArena(arena.url, "dev-carry", "carrier");
    const token = (await first.next(S2C.TOKEN)).str();
    const life = [...game.clients][0]!.life;
    assert.ok(life, "a life started with the spawn");
    await first.close();
    await sleep(60);
    const second = await joinArena(arena.url, "dev-carry", "carrier", token);
    const now = [...game.clients][0]!.life;
    assert.ok(now);
    assert.equal(now.startAt, life.startAt, "the clock on the life did not restart");
    await second.close();
  } finally {
    await arena.stop();
  }
});

test("a head-on names each snake as the other's killer and frees both wire ids", async () => {
  const arena = await startArena();
  try {
    const game = arena.game as unknown as {
      nids: Map<string, number>;
      stopLoop(): void;
      step(dt: number): void;
    };
    const a = await joinArena(arena.url, "dev-head-a", "left");
    const b = await joinArena(arena.url, "dev-head-b", "right");
    const world = arena.game.world;
    const sa = world.snakes.find((s) => s.name === "left")!;
    const sb = world.snakes.find((s) => s.name === "right")!;
    const nidA = game.nids.get(sa.id)!;
    const nidB = game.nids.get(sb.id)!;
    // An empty stretch of arena, stepped by hand, with the two heads pointed at each other.
    game.stopLoop();
    await sleep(60);
    world.clearBots();
    world.desiredBots = 0;
    for (const [s, x, angle] of [
      [sa, -150, 0],
      [sb, 150, Math.PI],
    ] as const) {
      s.x = x;
      s.y = 0;
      s.angle = angle;
      s.invuln = 0;
      s.points = [];
      world.ensureTrail(s);
      world.inputs.get(s.id)!.angle = angle;
    }
    for (let i = 0; i < 200 && world.snakes.some((s) => !s.isBot); i++) game.step(1 / 40);
    assert.ok(!world.snakes.some((s) => !s.isBot), "both heads died");
    const deathOf = async (p: Player, nid: number): Promise<number> => {
      for (;;) {
        const r = await p.next(S2C.DEATH, 1000);
        const who = r.u16();
        const killer = r.u16();
        if (who === nid) return killer;
      }
    };
    assert.equal(await deathOf(a, nidA), nidB, "the left snake was killed by the right one");
    assert.equal(await deathOf(b, nidB), nidA, "and the right one by the left");
    assert.ok(!game.nids.has(sa.id) && !game.nids.has(sb.id), "neither id lingers");
    await a.close();
    await b.close();
  } finally {
    await arena.stop();
  }
});

test("a signed-in player is linked on connect and chooses the handle they are named by", async () => {
  const arena = await startArena();
  const site = await fakeSite("u_rob", "robert_eno", "Robert - Eno");
  const other = await fakeSite("u_two", "someone", "Someone");
  try {
    const ticket = "t".repeat(24);
    const p = new Player(arena.url);
    await p.open();
    p.send(identWith("dev-rob", "rob", site.origin, ticket));
    let profile = parseProfile(await p.next(S2C.PROFILE));
    assert.equal(profile.linked, true, "linked before the first life");
    assert.equal(profile.handle, "robert_eno", "the site's derived handle is the default");
    // A name that breaks the rules costs nothing and changes nothing.
    p.send(handleMsg("7"));
    let r = await p.next(S2C.HANDLE);
    assert.equal(r.u8(), protocol.HANDLE_INVALID);
    assert.equal(r.str(), "robert_eno");
    // A typed name is normalised and claimed; the profile follows.
    p.send(handleMsg(" @Rob Eno "));
    r = await p.next(S2C.HANDLE);
    assert.equal(r.u8(), protocol.HANDLE_OK);
    assert.equal(r.str(), "rob_eno");
    profile = parseProfile(await p.next(S2C.PROFILE));
    assert.equal(profile.handle, "rob_eno");
    // Playing: the snake carries the chosen name, whatever HELLO said.
    p.send(hello("rob", "dev-rob"));
    await p.next(S2C.SPAWNED);
    const me = arena.game.world.snakes.find((s) => !s.isBot);
    assert.equal(me?.name, "@rob_eno");
    // Renamed mid-life, after the cooldown: the live snake follows at once.
    p.send(handleMsg("robeno"));
    assert.equal((await p.next(S2C.HANDLE)).u8(), protocol.HANDLE_TOO_SOON);
    await sleep(1100);
    p.send(handleMsg("robeno"));
    r = await p.next(S2C.HANDLE);
    assert.equal(r.u8(), protocol.HANDLE_OK);
    assert.equal(me?.name, "@robeno");
    // Another account cannot take it.
    const q = new Player(arena.url);
    await q.open();
    q.send(identWith("dev-two", "two", other.origin, "u".repeat(24)));
    await q.next(S2C.PROFILE);
    q.send(handleMsg("robeno"));
    r = await q.next(S2C.HANDLE);
    assert.equal(r.u8(), protocol.HANDLE_TAKEN);
    assert.equal(r.str(), "someone");
    // A fresh sign-in derives "robert_eno" again, but the chosen handle stays.
    const again = new Player(arena.url);
    await again.open();
    again.send(identWith("dev-rob", "rob", site.origin, ticket));
    profile = parseProfile(await again.next(S2C.PROFILE));
    assert.equal(profile.handle, "robeno");
    // A guest cannot choose a name.
    const guest = await joinArena(arena.url, "dev-guest", "guest");
    guest.send(handleMsg("guesty"));
    assert.equal((await guest.next(S2C.HANDLE)).u8(), protocol.HANDLE_NOT_LINKED);
    await p.close();
    await q.close();
    await again.close();
    await guest.close();
  } finally {
    await site.close();
    await other.close();
    await arena.stop();
  }
});

/** Read a protocol 5 STATS2 message down to its nemesis id and the contract tail. */
function parseStats2(r: InstanceType<typeof Reader>): {
  nemesisNid: number;
  huntNid: number;
  huntSecs: number;
  huntReward: number;
  huntName: string;
  huntStreak: number;
  markNid: number;
  markSecs: number;
  markReward: number;
  markName: string;
  cutoffs: number[];
  xp: number;
  rested: number;
} {
  r.f32();
  r.u16();
  r.u16();
  r.u16();
  r.u16();
  const nb = r.u8();
  for (let i = 0; i < nb; i++) {
    r.u16();
    r.str();
    r.u32();
    r.f32();
    r.f32();
    r.u32();
    r.u8();
    r.u8();
    r.u8();
  }
  const nd = r.u8();
  for (let i = 0; i < nd; i++) {
    r.str();
    r.u32();
  }
  const np = r.u8();
  for (let i = 0; i < np; i++) {
    r.str();
    r.u32();
  }
  r.u8();
  r.u16();
  r.u16();
  r.u8();
  r.f32();
  r.f32();
  const nemesisNid = r.u16();
  const huntNid = r.u16();
  const huntSecs = r.u16();
  const huntReward = r.u16();
  r.f32();
  r.f32();
  const huntName = r.str();
  const huntStreak = r.u8();
  const markNid = r.u16();
  const markSecs = r.u16();
  const markReward = r.u16();
  const markName = r.str();
  const cutoffs = [r.u32(), r.u32(), r.u32(), r.u32(), r.u32()];
  const xp = r.u32();
  const rested = r.u32();
  assert.equal(r.remaining, 0, "stats fully consumed");
  return {
    cutoffs,
    xp,
    rested,
    nemesisNid,
    huntNid,
    huntSecs,
    huntReward,
    huntName,
    huntStreak,
    markNid,
    markSecs,
    markReward,
    markName,
  };
}

test("contracts: the hunter who fills one is paid, and the marked player is paid for outliving one", async () => {
  const arena = await startArena();
  try {
    const url5 = arena.url.replace(/v=2$/, "v=5");
    const a = await joinArena(url5, "dev-hunt-a", "hunter");
    const b = await joinArena(url5, "dev-hunt-b", "quarry");
    const game = arena.game as unknown as {
      nids: Map<string, number>;
      stopLoop(): void;
      step(dt: number): void;
      stepContracts(now: number): void;
      sendStatsAll(): void;
      clientBySid(sid: string): {
        life: { startAt: number } | null;
        hunt: { until: number } | null;
        mark: { until: number } | null;
      };
    };
    game.stopLoop();
    await sleep(60);
    const world = arena.game.world;
    world.clearBots();
    world.desiredBots = 0;
    const sa = world.snakes.find((s) => s.name === "hunter")!;
    const sb = world.snakes.find((s) => s.name === "quarry")!;
    // Two veterans of a fair size, close together, past spawn protection.
    const ready = (s: typeof sa, x: number, mass: number): void => {
      s.x = x;
      s.y = 0;
      s.mass = mass;
      s.invuln = 0;
      s.rookie = false;
      s.points = [];
      world.ensureTrail(s);
    };
    ready(sa, 0, 300);
    ready(sb, 400, 200);
    const ca = game.clientBySid(sa.id);
    // Contracts start half a minute into a life: the hunter's is older than that, the quarry's is not.
    ca.life!.startAt = Date.now() - 60_000;
    const noticeOf = async (p: Player, kind: number): Promise<string> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const r = await p.next(S2C.NOTICE, 1000);
        const k = r.u8();
        const text = r.str();
        if (k === kind) return text;
      }
      throw new Error(`no notice of kind ${kind}`);
    };
    a.drain(S2C.NOTICE);
    b.drain(S2C.NOTICE);
    game.stepContracts(Date.now());
    assert.match(await noticeOf(a, 6), /hunt quarry/);
    assert.match(await noticeOf(b, 9), /marked by hunter/);
    a.drain(S2C.STATS2);
    b.drain(S2C.STATS2);
    game.sendStatsAll();
    const nidA = game.nids.get(sa.id)!;
    const nidB = game.nids.get(sb.id)!;
    const sta = parseStats2(await a.next(S2C.STATS2));
    assert.equal(sta.huntNid, nidB, "the hunter's stats name the target");
    assert.ok(sta.huntReward > 0 && sta.huntSecs > 0, "with a reward and a clock");
    assert.equal(sta.huntName, "quarry");
    assert.deepEqual(sta.cutoffs, [0, 300, 800, 1500, 3000], "no field yet: the fixed ladder");
    const stb = parseStats2(await b.next(S2C.STATS2));
    assert.equal(stb.markNid, nidA, "the target's stats name the hunter");
    // The hunter takes the quarry down inside the clock: paid, and a streak begins.
    const before = sa.mass;
    (world as unknown as { kill(s: typeof sb, r: "snake", k: string, n: string): void }).kill(
      sb,
      "snake",
      sa.id,
      sa.name,
    );
    game.step(1 / 40);
    assert.match(await noticeOf(a, 7), /contract done · quarry/);
    assert.ok(sa.mass >= before + sta.huntReward, `paid (${before} -> ${sa.mass})`);
    // The quarry comes back and gets a contract on the hunter (whose own
    // gap keeps it from hunting), and the hunter outlives the clock.
    await sleep(450);
    b.send(hello("quarry", "dev-hunt-b", "", true));
    await b.next(S2C.SPAWNED);
    const sb2 = world.snakes.find((s) => s.name === "quarry" && s.alive)!;
    ready(sb2, 400, 200);
    ready(sa, 0, 300);
    const cb = game.clientBySid(sb2.id);
    cb.life!.startAt = Date.now() - 60_000;
    a.drain(S2C.NOTICE);
    b.drain(S2C.NOTICE);
    game.stepContracts(Date.now());
    assert.match(await noticeOf(b, 6), /hunt hunter/);
    assert.match(await noticeOf(a, 9), /marked by quarry/);
    const paidBefore = sa.mass;
    cb.hunt!.until = Date.now() - 1;
    ca.mark!.until = Date.now() - 1;
    game.stepContracts(Date.now());
    assert.match(await noticeOf(b, 8), /contract expired · hunter/);
    assert.match(await noticeOf(a, 16), /shook off quarry/);
    assert.ok(sa.mass > paidBefore, "the marked player was paid for outliving the mark");
    await a.close();
    await b.close();
  } finally {
    await arena.stop();
  }
});

test("a rival who pops you twice is your nemesis, the stats say when they are here, and taking them down is payback", async () => {
  const arena = await startArena();
  try {
    const url5 = arena.url.replace(/v=2$/, "v=5");
    const hunter = await joinArena(url5, "dev-hunter", "hunter");
    const prey = await joinArena(url5, "dev-prey", "prey");
    const game = arena.game as unknown as {
      stopLoop(): void;
      step(dt: number): void;
      nids: Map<string, number>;
    };
    const world = arena.game.world;
    game.stopLoop();
    await sleep(60);
    world.clearBots();
    world.desiredBots = 0;
    const snakeOf = (name: string) => world.snakes.find((s) => s.name === name && s.alive)!;
    /** A long wall driving north across the runner's path, and the runner heading east into it. */
    const arrange = (wallName: string, runnerName: string) => {
      const wall = snakeOf(wallName);
      const runner = snakeOf(runnerName);
      for (const [s, x, y, angle, mass] of [
        [wall, 0, 300, Math.PI / 2, 400],
        [runner, -300, 0, 0, 40],
      ] as const) {
        s.mass = mass;
        s.x = x;
        s.y = y;
        s.angle = angle;
        s.invuln = 0;
        s.points = [];
        world.ensureTrail(s);
        world.inputs.get(s.id)!.angle = angle;
      }
      return runner.id;
    };
    const runUntilDead = (id: string) => {
      for (let i = 0; i < 400 && world.snakes.some((s) => s.id === id && s.alive); i++)
        game.step(1 / 40);
      assert.ok(!world.snakes.some((s) => s.id === id && s.alive), "the runner died");
    };
    const respawn = async (p: Player, name: string, key: string) => {
      // Spawns are throttled per socket; a player cannot ask this fast, a test can.
      await sleep(450);
      p.send(hello(name, key, "", true));
      await p.next(S2C.SPAWNED);
    };
    // Twice the prey runs into the hunter's body.
    for (let n = 0; n < 2; n++) {
      const runner = arrange("hunter", "prey");
      prey.drain(S2C.PROFILE);
      runUntilDead(runner);
      const profile = parseProfile(await prey.next(S2C.PROFILE));
      assert.deepEqual(
        profile.nemesis,
        n === 0 ? { name: "", k: 0, d: 0 } : { name: "hunter", k: 2, d: 0 },
      );
      await respawn(prey, "prey", "dev-prey");
    }
    // The stats now name the hunter's live snake as the prey's nemesis.
    const hunterNid = game.nids.get(snakeOf("hunter").id)!;
    let seen = 0;
    for (let i = 0; i < 40 && !seen; i++) {
      game.step(1 / 40);
      const r = await prey.next(S2C.STATS2, 200).catch(() => null);
      if (r) seen = parseStats2(r).nemesisNid;
    }
    assert.equal(seen, hunterNid, "the nemesis id is the hunter's");
    // The hunter runs into the prey's body: payback.
    runUntilDead(arrange("prey", "hunter"));
    const notice = await (async () => {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const r = await prey.next(S2C.NOTICE, 1500);
        const kind = r.u8();
        const text = r.str();
        if (kind === 5) return text;
      }
      throw new Error("no payback notice");
    })();
    assert.equal(notice, "payback · hunter · 1-2");
    assert.equal((await prey.next(S2C.ACHIEVE)).str(), "payback");
    await hunter.close();
    await prey.close();
  } finally {
    await arena.stop();
  }
});

test("a socket asking to spawn again inside the throttle window is ignored", async () => {
  const arena = await startArena();
  try {
    const p = await joinArena(arena.url, "dev-spam", "spammer");
    await sleep(450);
    // Two respawn requests back to back: the first ends the life and spawns
    // once, the second is inside the window and does nothing.
    p.send(hello("spammer", "dev-spam", "", true));
    p.send(hello("spammer", "dev-spam", "", true));
    await p.next(S2C.SPAWNED);
    await assert.rejects(p.next(S2C.SPAWNED, 600), "no second spawn");
    assert.equal(arena.game.world.snakes.filter((s) => !s.isBot && s.alive).length, 1);
    await p.close();
  } finally {
    await arena.stop();
  }
});

test("an agent pass is honoured only when signed with the game secret and fresh", async () => {
  const check = (p: string | null): boolean => checkAgentPass(p, "test-secret");
  assert.equal(check(mintAgentPass("test-secret")), true, "signed with the secret");
  assert.equal(check(mintAgentPass("other-secret")), false, "signed with something else");
  assert.equal(check(mintAgentPass("test-secret", Date.now() - 2 * 86_400_000)), false, "stale");
  assert.equal(check(null), false);
  assert.equal(check("garbage"), false);
  assert.equal(check("123.abc"), false);
  // On a socket: the pass marks the client trusted; a forged one does not.
  const arena = await startArena();
  try {
    const game = arena.game as unknown as { clients: Set<{ trusted: boolean; key: string }> };
    const good = new Player(
      `${arena.url}&agent=${encodeURIComponent(mintAgentPass("test-secret"))}`,
    );
    await good.open();
    good.send(ident("dev-pass-good", "passer"));
    await good.next(S2C.PROFILE);
    const bad = new Player(`${arena.url}&agent=${encodeURIComponent(mintAgentPass("nope"))}`);
    await bad.open();
    bad.send(ident("dev-pass-bad", "forger"));
    await bad.next(S2C.PROFILE);
    const byKey = (k: string) => [...game.clients].find((c) => c.key === k)!;
    assert.equal(byKey("dev-pass-good").trusted, true);
    assert.equal(byKey("dev-pass-bad").trusted, false);
    await good.close();
    await bad.close();
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

test("a token kept from before a death buys a fresh snake, not the old one back", async () => {
  const arena = await startArena();
  try {
    const first = await joinArena(arena.url, "dev-dead-token", "ghost");
    const world = arena.game.world;
    const me = world.snakes.find((s) => !s.isBot)!;
    me.mass = 900;
    // Tokens are minted once a second with the snake's length in them.
    await sleep(1100);
    first.drain(S2C.TOKEN);
    const token = (await first.next(S2C.TOKEN)).str();
    // Into the rim: a real death, announced.
    me.x = 1e6;
    await first.next(S2C.DEATH, 2000);
    await first.close();
    const second = await joinArena(arena.url, "dev-dead-token", "ghost", token);
    const back = world.snakes.find((s) => !s.isBot && s.alive)!;
    assert.ok(back.mass < 100, `spawned fresh (length ${back.mass.toFixed(0)})`);
    await second.close();
  } finally {
    await arena.stop();
  }
});

test("a socket that never says hello, or falls silent, is closed", async () => {
  const arena = await startArena();
  try {
    const game = arena.game as unknown as { idleSocketMs: number; helloDeadlineMs: number };
    game.helloDeadlineMs = 300;
    game.idleSocketMs = 1500;
    const mute = new Player(arena.url);
    await mute.open();
    const closeReason = (ws: WebSocket): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        ws.once("close", (_code, reason) => resolve(reason.toString()));
        setTimeout(() => reject(new Error("socket still open")), 4000).unref();
      });
    const muteClosed = closeReason(mute.ws);
    // The idle sweep runs once a second.
    assert.equal(await muteClosed, "no hello");
    const p = await joinArena(arena.url, "dev-idle", "quiet");
    const ping = new Writer().u8(C2S.PING).u32(0).finish();
    // Kept alive by pings for two seconds, then left alone.
    for (let i = 0; i < 4; i++) {
      p.send(ping);
      await sleep(500);
    }
    assert.equal(p.ws.readyState, WebSocket.OPEN, "a pinging socket stays");
    assert.equal(await closeReason(p.ws), "idle");
  } finally {
    await arena.stop();
  }
});

test("a live snake's view is pinned near its head, so a far snake is not sent", async () => {
  const arena = await startArena();
  try {
    const a = await joinArena(arena.url, "dev-view-a", "peeker");
    const b = await joinArena(arena.url, "dev-view-b", "faraway");
    const game = arena.game as unknown as { nids: Map<string, number>; stopLoop(): void };
    const world = arena.game.world;
    const sa = world.snakes.find((s) => s.name === "peeker")!;
    const sb = world.snakes.find((s) => s.name === "faraway")!;
    const nidB = game.nids.get(sb.id)!;
    world.clearBots();
    world.desiredBots = 0;
    for (const [s, x] of [
      [sa, 0],
      [sb, 4000],
    ] as const) {
      s.x = x;
      s.y = 0;
      s.angle = Math.PI / 2;
      s.points = [];
      world.ensureTrail(s);
      world.inputs.get(s.id)!.angle = Math.PI / 2;
    }
    // A view claiming to sit right on the far snake.
    const peek = new Writer()
      .u8(C2S.INPUT)
      .u16(1)
      .angle(Math.PI / 2)
      .u8(0)
      .f32(4000)
      .f32(0)
      .f32(900)
      .f32(600)
      .u8(0)
      .finish();
    a.send(peek);
    await sleep(100);
    a.drain(S2C.SNAP);
    let sawB = false;
    for (let i = 0; i < 8; i++) {
      const entries = parseSnap(await a.next(S2C.SNAP), 2);
      if (entries.some((e) => e.nid === nidB)) sawB = true;
      a.send(peek);
    }
    assert.ok(!sawB, "the far snake never reached the peeker");
    await a.close();
    await b.close();
  } finally {
    await arena.stop();
  }
});

/** A player's server-side record and snake, by name. */
function clientOf(game: GameServerT, name: string) {
  const g = game as unknown as { clients: Set<{ sid: string | null; name: string }> };
  const s = game.world.snakes.find((x) => x.name === name)!;
  return { snake: s, client: [...g.clients].find((c) => c.sid === s.id)! };
}

test("a snake watched from the menu is reported gone once the player spawns out of its view", async () => {
  const arena = await startArena();
  try {
    const game = arena.game as unknown as {
      nids: Map<string, number>;
      stopLoop(): void;
      sendSnapshot(c: unknown): void;
    };
    const b = await joinArena(arena.url, "dev-gone-b", "target");
    const sb = arena.game.world.snakes.find((s) => s.name === "target")!;
    const nidB = game.nids.get(sb.id)!;
    // A sits in the menu with its view on the target, and holds it.
    const a = new Player(arena.url);
    await a.open();
    a.send(ident("dev-gone-a", "watcher"));
    await a.next(S2C.PROFILE);
    const viewOn = (x: number, y: number): Uint8Array =>
      new Writer()
        .u8(C2S.INPUT)
        .u16(1)
        .angle(0)
        .u8(0)
        .f32(x)
        .f32(y)
        .f32(900)
        .f32(600)
        .u8(0)
        .finish();
    a.send(viewOn(sb.x, sb.y));
    const deadline = Date.now() + 3000;
    let held = false;
    while (!held && Date.now() < deadline)
      held = parseSnap(await a.next(S2C.SNAP), 2).some((e) => e.nid === nidB && e.full);
    assert.ok(held, "the watcher holds the target");
    // Now A spawns, looks at its own head, and the target is far away: the
    // very next snapshot must name the target as gone.
    game.stopLoop();
    await sleep(60);
    a.send(hello("watcher", "dev-gone-a"));
    await a.next(S2C.SPAWNED);
    const { snake: sa, client } = clientOf(arena.game, "watcher");
    sb.x = sa.x + 5000;
    sb.y = sa.y;
    sb.points = [];
    arena.game.world.ensureTrail(sb);
    a.send(viewOn(sa.x, sa.y));
    await sleep(100);
    a.drain(S2C.SNAP);
    game.sendSnapshot(client);
    const r = await a.next(S2C.SNAP);
    r.u32();
    r.u32();
    const n = r.u16();
    for (let i = 0; i < n; i++) {
      const e = protocol.readSnakeEntry(r);
      if (e.full) r.u8();
      assert.notEqual(e.nid, nidB, "the far target is not in the snapshot");
    }
    const gone: number[] = [];
    const g = r.u16();
    for (let i = 0; i < g; i++) gone.push(r.u16());
    assert.ok(gone.includes(nidB), `the target is reported gone (${JSON.stringify(gone)})`);
    await a.close();
    await b.close();
  } finally {
    await arena.stop();
  }
});

test("a snake that was just promoted still dies on everyone's screen", async () => {
  const arena = await startArena();
  try {
    const game = arena.game as unknown as {
      nids: Map<string, number>;
      stopLoop(): void;
      step(dt: number): void;
      sendSnapshot(c: unknown): void;
      checkPromotions(): void;
    };
    const a = await joinArena(arena.url, "dev-promo-a", "witness");
    const b = await joinArena(arena.url, "dev-promo-b", "climber");
    game.stopLoop();
    await sleep(60);
    const world = arena.game.world;
    const { snake: sa, client: ca } = clientOf(arena.game, "witness");
    const sb = world.snakes.find((s) => s.name === "climber")!;
    const nidB = game.nids.get(sb.id)!;
    sb.x = sa.x + 150;
    sb.y = sa.y;
    sb.points = [];
    world.ensureTrail(sb);
    a.send(
      new Writer()
        .u8(C2S.INPUT)
        .u16(1)
        .angle(0)
        .u8(0)
        .f32(sa.x)
        .f32(sa.y)
        .f32(900)
        .f32(600)
        .u8(0)
        .finish(),
    );
    await sleep(100);
    a.drain(S2C.SNAP);
    game.sendSnapshot(ca);
    assert.ok(
      parseSnap(await a.next(S2C.SNAP), 2).some((e) => e.nid === nidB && e.full),
      "the witness holds the climber",
    );
    // Silver, then dead before the next snapshot.
    sb.mass = 350;
    game.checkPromotions();
    world.killSnake(sb.id);
    game.step(1 / 40);
    const d = await a.next(S2C.DEATH, 1500);
    assert.equal(d.u16(), nidB, "the witness hears the climber die");
    await a.close();
    await b.close();
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
  out.handle = r.str();
  out.linked = r.u8() === 1;
  r.str();
  out.bankedTier = r.u8();
  out.weekLives = r.u8();
  out.weekRuns = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
  out.seasonTier = r.u8();
  out.seasons = r.str();
  out.streakNext = r.u16();
  out.playedToday = r.u8() === 1;
  out.nemesis = { name: r.str(), k: r.u8(), d: r.u8() };
  out.xp = r.u32();
  out.rested = r.u32();
  out.scales = r.u32();
  assert.equal(r.remaining, 0, "profile fully consumed");
  return out;
}

test("protocol 4 full entries carry league, might and finish, protocol 5 board rows level and flags; older protocols keep their layouts", async () => {
  const arena = await startArena();
  try {
    for (const proto of [2, 3, 4, 5]) {
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
        if (proto >= 5) {
          stats.u8();
          assert.ok(stats.u8() <= 3, "flags byte: crown 1, linked 2");
        }
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
      stats.u16();
      // The contract tail: no contract in this test, but the fields are always there.
      stats.u16();
      stats.u16();
      stats.u16();
      stats.f32();
      stats.f32();
      stats.str();
      stats.u8();
      stats.u16();
      stats.u16();
      stats.u16();
      stats.str();
      for (let i = 0; i < 5; i++) stats.u32();
      // Experience and the rested pool, for the bar.
      stats.u32();
      stats.u32();
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
    const other = arena.game.world.snakes.find((s) => s.name === "watcher");
    assert.ok(me && other);
    // Put the climber beside the watcher, whose view sits on its own head.
    me.x = other.x + 200;
    me.y = other.y;
    me.points = [];
    arena.game.world.ensureTrail(me);
    watcher.send(
      new Writer()
        .u8(C2S.INPUT)
        .u16(1)
        .angle(0)
        .u8(0)
        .f32(other.x)
        .f32(other.y)
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
    // Silver was private; Gold is announced to everyone else in the arena.
    me.mass = 850;
    const line = await (async () => {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const r = await watcher.next(S2C.NOTICE, 1500);
        const kind = r.u8();
        const text = r.str();
        if (/reached Gold/.test(text)) return { kind, text };
      }
      throw new Error("the watcher never heard about Gold");
    })();
    assert.equal(line.kind, 0, "a plain feed line for everyone");
    assert.equal(line.text, "climber reached Gold");
    await p.close();
    await watcher.close();
  } finally {
    await arena.stop();
  }
});
test("experience: growth is booked as the snake grows, a kill pays, levels pay scales, and the life's line sums it", async () => {
  const arena = await startArena();
  try {
    const url5 = arena.url.replace(/v=2$/, "v=5");
    const a = await joinArena(url5, "dev-xp-a", "grower");
    const b = await joinArena(url5, "dev-xp-b", "victim");
    const game = arena.game as unknown as {
      stopLoop(): void;
      step(dt: number): void;
      sendStatsAll(): void;
      clientBySid(sid: string): {
        profile: { xp: number; scales: number; trackClaimed: number } | null;
        life: { startMass: number } | null;
      };
    };
    game.stopLoop();
    await sleep(60);
    const world = arena.game.world;
    world.clearBots();
    world.desiredBots = 0;
    const sa = world.snakes.find((s) => s.name === "grower")!;
    const sb = world.snakes.find((s) => s.name === "victim")!;
    const ca = game.clientBySid(sa.id);
    const start = ca.life!.startMass;
    assert.equal(ca.profile!.xp, 0);
    const noticeOf = async (p: Player, kind: number): Promise<string> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const r = await p.next(S2C.NOTICE, 1000);
        const k = r.u8();
        const text = r.str();
        if (k === kind) return text;
      }
      throw new Error(`no notice of kind ${kind}`);
    };
    a.drain(S2C.NOTICE);
    // Growth follows the peak: booked as it happens, unmoved by shedding,
    // and equal to the closed form whatever path the length took.
    sa.mass = start + 990;
    game.step(1 / 40);
    assert.equal(ca.profile!.xp, growthXp(990), "growth booked at once");
    assert.match(await noticeOf(a, 18), /^level 2 · \+27 scales$/, "level 2 announced and paid");
    sa.mass = start + 500;
    game.step(1 / 40);
    assert.equal(ca.profile!.xp, growthXp(990), "shedding costs nothing");
    sa.mass = start + 2000;
    game.step(1 / 40);
    assert.equal(ca.profile!.xp, growthXp(2000));
    a.drain(S2C.STATS2);
    game.sendStatsAll();
    const st = parseStats2(await a.next(S2C.STATS2));
    assert.equal(st.xp, growthXp(2000), "the stats tail carries xp for the bar");
    assert.equal(st.rested, 0);
    // A kill pays by the victim's length.
    sb.mass = 400;
    (world as unknown as { kill(s: typeof sb, r: "snake", k: string, n: string): void }).kill(
      sb,
      "snake",
      sa.id,
      sa.name,
    );
    game.step(1 / 40);
    assert.equal(ca.profile!.xp, growthXp(2000) + killXp(400));
    assert.match(await noticeOf(a, 18), /^level 3 · \+28 scales$/);
    assert.equal(ca.profile!.scales, 27 + 28);
    assert.equal(ca.profile!.trackClaimed, 3);
    // The life ends: the daily bonus lands, the line sums every part, and
    // the profile's tail carries the totals.
    const profile = ca.profile!;
    a.drain(S2C.NOTICE);
    a.drain(S2C.PROFILE);
    (world as unknown as { kill(s: typeof sa, r: "wall", k: null, n: null): void }).kill(
      sa,
      "wall",
      null,
      null,
    );
    game.step(1 / 40);
    const line = await noticeOf(a, 17);
    const m = /^\+(\d+) XP · growth 478 · kills 65 · bonus (\d+) · (\d+) scales$/.exec(line);
    assert.ok(m, `the life's line (${line})`);
    assert.equal(Number(m![1]), 478 + 65 + Number(m![2]), "the parts sum to the total");
    assert.ok(Number(m![2]) >= 100, "the first life of the day pays its bonus");
    assert.equal(Number(m![3]), 40 + 10, "a 2010 life with a kill pays 50 scales");
    const tail = parseProfile(await a.next(S2C.PROFILE));
    assert.equal(tail.xp, profile.xp);
    assert.equal(tail.scales, profile.scales);
    // The bonus can carry the profile over another level, whose track pays too.
    let track = 0;
    for (let l = 2; l <= levelOf(profile.xp); l++) track += 25 + l;
    assert.equal(profile.scales, track + 50);
    assert.equal(profile.trackClaimed, levelOf(profile.xp));
    await a.close();
    await b.close();
  } finally {
    await arena.stop();
  }
});
/** Read a WARDROBE message: status, the five equipped ids, the owned ids. */
function parseWardrobe(r: InstanceType<typeof Reader>): {
  status: number;
  equipped: string[];
  owned: string[];
} {
  const status = r.u8();
  const equipped = [r.str(), r.str(), r.str(), r.str(), r.str()];
  const n = r.u16();
  const owned: string[] = [];
  for (let i = 0; i < n; i++) owned.push(r.str());
  assert.equal(r.remaining, 0, "wardrobe fully consumed");
  return { status, equipped, owned };
}

test("the wardrobe: protocol 6 entries carry the loadout, equips need ownership, a level pays its piece, the shelf sells", async () => {
  const arena = await startArena();
  try {
    const url6 = arena.url.replace(/v=2$/, "v=6");
    const p = new Player(url6);
    await p.open();
    p.send(ident("dev-ward", "dresser"));
    await p.next(S2C.PROFILE);
    const first = parseWardrobe(await p.next(S2C.WARDROBE));
    assert.equal(first.status, 0);
    assert.deepEqual(first.equipped, ["", "", "", "", ""]);
    assert.deepEqual(first.owned, []);
    p.send(hello("dresser", "dev-ward"));
    await p.next(S2C.SPAWNED);
    const game = arena.game as unknown as {
      stopLoop(): void;
      step(dt: number): void;
      sendSnapshot(c: unknown): void;
      clients: Set<{
        sid: string | null;
        profile: { xp: number; scales: number; wardrobe: Record<string, number> } | null;
      }>;
      profiles: { grantFresh(p: unknown, id: string): boolean };
      clientBySid(sid: string): unknown;
    };
    game.stopLoop();
    await sleep(60);
    const world = arena.game.world;
    world.clearBots();
    world.desiredBots = 0;
    const me = world.snakes.find((s) => s.name === "dresser")!;
    const client = [...game.clients].find((c) => c.sid === me.id)!;
    // A profile refresh carries the wardrobe too, so each request starts with a clean queue.
    const wardrobe = (op: number, slot: number, id: string) => {
      p.drain(S2C.WARDROBE);
      p.send(new Writer().u8(C2S.WARDROBE).u8(op).u8(slot).str(id).finish());
    };
    // Nothing owned: an equip is refused.
    p.drain(S2C.WARDROBE);
    wardrobe(1, 0, "halo");
    assert.equal(parseWardrobe(await p.next(S2C.WARDROBE)).status, 1, "not owned");
    // Reaching level 5 hands out Horn Nubs and says so.
    client.profile!.xp = xpForLevel(5) - 1;
    p.drain(S2C.NOTICE);
    p.drain(S2C.LOOT);
    me.mass = me.mass + 300;
    game.step(1 / 40);
    const loot = await p.next(S2C.LOOT);
    assert.equal(loot.str(), "horn_nubs");
    loot.u8();
    assert.equal(loot.u8(), 0, "source: the level track");
    assert.equal(loot.u16(), 0, "not a duplicate");
    const deadline = Date.now() + 2000;
    let text = "";
    while (Date.now() < deadline) {
      const r = await p.next(S2C.NOTICE, 1000);
      if (r.u8() === 18) {
        text = r.str();
        break;
      }
    }
    assert.match(text, /^level 5 · \+\d+ scales · Horn Nubs$/);
    // Equip it: the answer names it, and everyone gets the snake's full entry with the loadout.
    await sleep(260);
    p.drain(S2C.WARDROBE);
    wardrobe(1, 0, "horn_nubs");
    const w = parseWardrobe(await p.next(S2C.WARDROBE));
    assert.equal(w.status, 0);
    assert.equal(w.equipped[0], "horn_nubs");
    assert.deepEqual(w.owned, ["horn_nubs"]);
    assert.deepEqual(me.loadout, [cosmeticIndex("horn_nubs"), 0, 0, 0, 0]);
    p.drain(S2C.SNAP);
    game.sendSnapshot(client);
    const snap = await p.next(S2C.SNAP);
    snap.u32();
    snap.u32();
    const n = snap.u16();
    let found = false;
    for (let i = 0; i < n; i++) {
      const e = protocol.readSnakeEntry(snap);
      if (!e.full) continue;
      snap.u8();
      snap.u8();
      snap.u8();
      snap.u8();
      const loadout = [snap.u8(), snap.u8(), snap.u8(), snap.u8(), snap.u8()];
      if (e.name === "dresser") {
        assert.deepEqual(loadout, [cosmeticIndex("horn_nubs"), 0, 0, 0, 0]);
        found = true;
      }
    }
    assert.ok(found, "the full entry after an equip carries the loadout");
    // The wrong slot and a piece in the wrong place are refused; taking off works.
    await sleep(260);
    wardrobe(1, 1, "horn_nubs");
    assert.equal(parseWardrobe(await p.next(S2C.WARDROBE)).status, 2, "wrong slot");
    await sleep(260);
    wardrobe(2, 0, "");
    const off = parseWardrobe(await p.next(S2C.WARDROBE));
    assert.equal(off.status, 0);
    assert.equal(off.equipped[0], "");
    assert.deepEqual(me.loadout, [0, 0, 0, 0, 0]);
    // The shelf: too poor, then bought, then owned.
    const shelf = (await import("../../src/game/cosmetics.ts")).shopFor(
      (await import("../../src/game/challenges.ts")).isoWeek(),
    );
    const piece = shelf[0]!;
    const price = piece.source.kind === "shop" ? piece.source.price : 0;
    client.profile!.scales = price - 1;
    await sleep(260);
    wardrobe(3, 0, piece.id);
    assert.equal(parseWardrobe(await p.next(S2C.WARDROBE)).status, 4, "too poor");
    client.profile!.scales = price;
    await sleep(260);
    p.drain(S2C.LOOT);
    wardrobe(3, 0, piece.id);
    const bought = parseWardrobe(await p.next(S2C.WARDROBE));
    assert.equal(bought.status, 0);
    assert.ok(bought.owned.includes(piece.id));
    assert.equal(client.profile!.scales, 0);
    const l2 = await p.next(S2C.LOOT);
    assert.equal(l2.str(), piece.id);
    await sleep(260);
    wardrobe(3, 0, piece.id);
    assert.equal(parseWardrobe(await p.next(S2C.WARDROBE)).status, 7, "already owned");
    await sleep(260);
    wardrobe(3, 0, "halo");
    assert.equal(parseWardrobe(await p.next(S2C.WARDROBE)).status, 3, "never sold");
    await p.close();
  } finally {
    await arena.stop();
  }
});
test("loot orbs: a big player's death by another player drops one, never twice in ten minutes, never for party mates, agents or bots; eating it rolls a piece", async () => {
  const arena = await startArena();
  try {
    const url6 = arena.url.replace(/v=2$/, "v=6");
    const killer = await joinArena(url6, "dev-loot-k", "hunter");
    const victim = await joinArena(url6, "dev-loot-v", "prey");
    const game = arena.game as unknown as {
      rand: () => number;
      stopLoop(): void;
      step(dt: number): void;
      clients: Set<{ sid: string | null; party: string; trusted: boolean }>;
    };
    game.stopLoop();
    await sleep(60);
    game.rand = () => 0;
    const world = arena.game.world;
    world.clearBots();
    world.desiredBots = 0;
    const kill = (s: (typeof world.snakes)[number], by: (typeof world.snakes)[number]): void => {
      (world as unknown as { kill(s: unknown, r: "snake", k: string, n: string): void }).kill(
        s,
        "snake",
        by.id,
        by.name,
      );
      game.step(1 / 40);
    };
    const orbs = () => [...world.foodById.values()].filter((f) => f.k === 5);
    const respawn = async (p: Player, name: string, key: string) => {
      p.send(hello(name, key, "", true));
      await p.next(S2C.SPAWNED);
      const s = world.snakes.find((x) => x.name === name && x.alive)!;
      s.invuln = 0;
      return s;
    };
    const sk = world.snakes.find((s) => s.name === "hunter")!;
    let sv = world.snakes.find((s) => s.name === "prey")!;
    sv.mass = 250;
    kill(sv, sk);
    assert.equal(orbs().length, 0, "under 300 drops nothing");
    await sleep(450);
    sv = await respawn(victim, "prey", "dev-loot-v");
    sv.mass = 1500;
    sv.x = 900;
    sv.y = 900;
    kill(sv, sk);
    const [orb] = orbs();
    assert.ok(orb, "a 1,500 victim drops an orb");
    assert.equal(orb!.c, 1, "the orb carries the middle band");
    assert.ok(Math.hypot(orb!.x - 900, orb!.y - 900) < 60, "among the remains");
    await sleep(450);
    sv = await respawn(victim, "prey", "dev-loot-v");
    sv.mass = 1500;
    kill(sv, sk);
    assert.equal(orbs().length, 1, "the same victim drops nothing twice in ten minutes");
    // A bot victim drops nothing, and neither does a party mate.
    const bot = world.spawnBot(new Set(), true);
    bot.mass = 2000;
    kill(bot, sk);
    assert.equal(orbs().length, 1, "bots drop nothing");
    await sleep(450);
    sv = await respawn(victim, "prey", "dev-loot-v");
    sv.mass = 1500;
    const cv = [...game.clients].find((c) => c.sid === sv.id)!;
    const ck = [...game.clients].find((c) => c.sid === sk.id)!;
    (arena.game as unknown as { lootedAt: Map<string, number> }).lootedAt.clear();
    cv.party = "abc";
    ck.party = "abc";
    kill(sv, sk);
    assert.equal(orbs().length, 1, "party mates drop nothing for each other");
    cv.party = "";
    ck.party = "";
    await sleep(450);
    sv = await respawn(victim, "prey", "dev-loot-v");
    sv.mass = 1500;
    (arena.game as unknown as { lootedAt: Map<string, number> }).lootedAt.clear();
    ck.trusted = true;
    kill(sv, sk);
    assert.equal(orbs().length, 1, "the owner's agents neither drop nor cause drops");
    ck.trusted = false;
    // The hunter eats the orb: a piece from the band's pool, announced to them.
    killer.drain(S2C.LOOT);
    sk.x = orb!.x;
    sk.y = orb!.y;
    sk.invuln = 0;
    game.step(1 / 40);
    const l = await killer.next(S2C.LOOT);
    const id = l.str();
    assert.ok(
      dropPool().some((c) => c.id === id),
      `a piece from the drop pool (${id})`,
    );
    l.u8();
    assert.equal(l.u8(), 3, "source: a drop");
    assert.equal(orbs().length, 0, "the orb is gone");
    await killer.close();
    await victim.close();
  } finally {
    await arena.stop();
  }
});

test("the leviathan's death pays everyone who hit it a roll, and the final cut a set piece", async () => {
  const arena = await startArena();
  try {
    const url6 = arena.url.replace(/v=2$/, "v=6");
    const a = await joinArena(url6, "dev-boss-a", "cutter");
    const b = await joinArena(url6, "dev-boss-b", "watcher");
    const game = arena.game as unknown as {
      rand: () => number;
      stopLoop(): void;
      step(dt: number): void;
      stepBoss(): void;
      boss: unknown;
      bossUntil: number;
    };
    game.stopLoop();
    await sleep(60);
    game.rand = () => 0.5;
    const world = arena.game.world;
    world.clearBots();
    world.desiredBots = 0;
    const boss = world.spawnBoss({ x: 0, y: 0 });
    boss.angle = 0;
    boss.wander = 0;
    boss.points = [];
    for (let x = -600; x <= 0; x += 20) boss.points.push({ x, y: 0 });
    boss.x = 0;
    boss.y = 0;
    boss.hp = 1;
    game.boss = boss;
    game.bossUntil = Date.now() + 60_000;
    const sa = world.snakes.find((s) => s.name === "cutter")!;
    sa.x = -300;
    sa.y = 50;
    sa.angle = -Math.PI / 2;
    sa.invuln = 0;
    sa.points = [];
    world.ensureTrail(sa);
    world.inputs.set(sa.id, { angle: -Math.PI / 2, boost: false, seq: 0, lag: 0 } as never);
    const sb = world.snakes.find((s) => s.name === "watcher")!;
    sb.x = 3000;
    sb.y = 3000;
    a.drain(S2C.LOOT);
    a.drain(S2C.NOTICE);
    b.drain(S2C.NOTICE);
    for (let i = 0; i < 80 && boss.alive; i++) game.step(1 / 40);
    assert.equal(boss.alive, false, "the cut killed it");
    game.stepBoss();
    // rand 0.5: the participant roll pays 150 scales, the final roll is
    // Spines; the boss slayer feat's own piece arrives first.
    const pieces: { id: string; source: number; scales: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const l = await a.next(S2C.LOOT, 1500).catch(() => null);
      if (!l) break;
      const id = l.str();
      l.u8();
      pieces.push({ id, source: l.u8(), scales: l.u16() });
    }
    assert.ok(
      pieces.some((x) => x.id === "slayer_name" && x.source === 4),
      "the boss slayer feat hands out Slayer Name",
    );
    assert.ok(
      pieces.some((x) => x.id === "leviathan_spines" && x.source === 2 && x.scales === 0),
      `the final cut takes Spines (${pieces.map((x) => x.id).join(",")})`,
    );
    const texts: string[] = [];
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && texts.length < 8) {
      const r = await a.next(S2C.NOTICE, 500).catch(() => null);
      if (!r) break;
      r.u8();
      texts.push(r.str());
    }
    assert.ok(
      texts.some((t) => /the leviathan left you 150 scales/.test(t)),
      texts.join(" | "),
    );
    assert.ok(texts.some((t) => /the final cut left you Leviathan Spines \(epic\)/.test(t)));
    // The watcher hears about the epic, and gets nothing (no hit).
    const heard = await b.next(S2C.NOTICE, 2000);
    heard.u8();
    assert.match(heard.str(), /landed the final cut|found Leviathan Spines \(epic\)/);
    await a.close();
    await b.close();
  } finally {
    await arena.stop();
  }
});
