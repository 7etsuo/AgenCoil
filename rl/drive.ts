/**
 * Drives the browser client with a trained policy, for watching it play.
 * Bundled by rl/watch.mjs and injected into the page with the weights on
 * `window.__coilWeights`; the engine calls `window.__coilDrive` each frame.
 */
import type { Snake } from "../src/game/model";
import type { World } from "../src/game/world";
import { DECISION_TICKS, OBS_DIM, TURNS, encodeObservation } from "./env";

interface Weights {
  layers: { w: number[][]; b: number[] }[];
}

const weights = (window as unknown as { __coilWeights: Weights }).__coilWeights;
const obs = new Float32Array(OBS_DIM);
let lastAt = 0;
let lastAction = 4;

function forward(x: Float32Array): number {
  let h: Float32Array = x;
  weights.layers.forEach((layer, i) => {
    const out = new Float32Array(layer.b.length);
    for (let j = 0; j < out.length; j++) {
      let acc = layer.b[j]!;
      const row = layer.w[j]!;
      for (let k = 0; k < row.length; k++) acc += row[k]! * h[k]!;
      out[j] = i < weights.layers.length - 1 ? Math.tanh(acc) : acc;
    }
    h = out;
  });
  let best = 0;
  for (let j = 1; j < h.length; j++) if (h[j]! > h[best]!) best = j;
  return best;
}

(window as unknown as { __coilDrive: unknown }).__coilDrive = (
  world: World,
  me: Snake,
): { angle: number; boost: boolean } => {
  const now = performance.now();
  // One decision every DECISION_TICKS ticks of the server rate, as in training.
  if (now - lastAt >= (DECISION_TICKS * 1000) / 40) {
    encodeObservation(world, me, obs, 0);
    lastAction = forward(obs);
    lastAt = now;
  }
  return {
    angle: me.angle + TURNS[lastAction % TURNS.length]!,
    boost: lastAction >= TURNS.length,
  };
};
