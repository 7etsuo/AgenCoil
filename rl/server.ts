/**
 * Serves many arenas to a learner over a local TCP socket. The learner
 * sends one byte (0 reset, 1 step), a little-endian u32 count and that many
 * int8 actions; the answer is u32 N, u32 D, u32 L, then N by D float32
 * observations, N float32 rewards, N uint8 dones and L bytes of JSON: the
 * lives that ended this step. Arenas run in worker threads, one each.
 */
import net from "node:net";
import { Worker } from "node:worker_threads";
import { OBS_DIM, type LifeStats, type StepResult } from "./env";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}
const workers = arg("workers", 32);
const agents = arg("agents", 8);
const bots = arg("bots", 50);
const port = arg("port", 5555);
/** Decisions between world resets per arena (0 never); arenas are staggered across the interval. */
const resetEvery = arg("reset", 0);
const workerPath = process.env.RL_WORKER ?? new URL("./worker.mjs", import.meta.url).pathname;

const pool = Array.from(
  { length: workers },
  (_, i) =>
    new Worker(workerPath, {
      workerData: {
        agents,
        bots,
        resetEvery,
        resetOffset: resetEvery ? Math.floor((resetEvery * i) / workers) : 0,
      },
    }),
);
const N = workers * agents;

function ask<T>(w: Worker, msg: unknown, transfer: ArrayBuffer[] = []): Promise<T> {
  return new Promise((resolve) => {
    w.once("message", resolve);
    w.postMessage(msg, transfer);
  });
}

async function resetAll(): Promise<Buffer> {
  const replies = await Promise.all(
    pool.map((w) => ask<{ obs: Float32Array }>(w, { cmd: "reset" })),
  );
  const obs = new Float32Array(N * OBS_DIM);
  replies.forEach((r, i) => obs.set(r.obs, i * agents * OBS_DIM));
  return frame(obs, new Float32Array(N), new Uint8Array(N), []);
}

async function stepAll(actions: Int8Array): Promise<Buffer> {
  const replies = await Promise.all(
    pool.map((w, i) => {
      const slice = actions.slice(i * agents, (i + 1) * agents);
      return ask<StepResult>(w, { cmd: "step", actions: slice }, [slice.buffer as ArrayBuffer]);
    }),
  );
  const obs = new Float32Array(N * OBS_DIM);
  const rewards = new Float32Array(N);
  const dones = new Uint8Array(N);
  const ended: LifeStats[] = [];
  replies.forEach((r, i) => {
    obs.set(r.obs, i * agents * OBS_DIM);
    rewards.set(r.rewards, i * agents);
    dones.set(r.dones, i * agents);
    ended.push(...r.ended);
  });
  return frame(obs, rewards, dones, ended);
}

function frame(
  obs: Float32Array,
  rewards: Float32Array,
  dones: Uint8Array,
  ended: LifeStats[],
): Buffer {
  const info = Buffer.from(JSON.stringify(ended));
  const head = Buffer.alloc(12);
  head.writeUInt32LE(N, 0);
  head.writeUInt32LE(OBS_DIM, 4);
  head.writeUInt32LE(info.length, 8);
  return Buffer.concat([
    head,
    Buffer.from(obs.buffer, obs.byteOffset, obs.byteLength),
    Buffer.from(rewards.buffer, rewards.byteOffset, rewards.byteLength),
    Buffer.from(dones.buffer, dones.byteOffset, dones.byteLength),
    info,
  ]);
}

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  let pending = Buffer.alloc(0);
  let busy: Promise<void> = Promise.resolve();
  sock.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    busy = busy.then(async () => {
      for (;;) {
        if (pending.length < 5) return;
        const cmd = pending.readUInt8(0);
        const n = pending.readUInt32LE(1);
        if (pending.length < 5 + n) return;
        const actions = new Int8Array(n);
        for (let i = 0; i < n; i++) actions[i] = pending.readInt8(5 + i);
        pending = pending.subarray(5 + n);
        const out = cmd === 0 ? await resetAll() : await stepAll(actions);
        await new Promise<void>((resolve) => sock.write(out, () => resolve()));
      }
    });
  });
  sock.on("error", () => undefined);
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    `rl server: ${workers} arenas x ${agents} agents (${N}) on 127.0.0.1:${port}, obs ${OBS_DIM}`,
  );
});
