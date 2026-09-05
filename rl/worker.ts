/** One arena per worker thread; the server fans a step out to all of them. */
import { parentPort, workerData } from "node:worker_threads";
import { Arena } from "./env";

const data = workerData as {
  agents: number;
  bots: number;
  resetEvery: number;
  resetOffset: number;
};
const arena = new Arena(data);
const port = parentPort!;
port.on("message", (m: { cmd: "reset" } | { cmd: "step"; actions: Int8Array }) => {
  if (m.cmd === "reset") {
    const obs = arena.reset();
    port.postMessage({ obs }, [obs.buffer as ArrayBuffer]);
    return;
  }
  const r = arena.step(m.actions);
  port.postMessage(r, [
    r.obs.buffer as ArrayBuffer,
    r.rewards.buffer as ArrayBuffer,
    r.dones.buffer as ArrayBuffer,
  ]);
});
