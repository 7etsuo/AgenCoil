/**
 * Headless clients driven by a trained policy, for playing against it on a
 * live arena. Each one is the real client netcode (`NetSession`: the same
 * mirror world, prediction and reconnection the browser uses) with the
 * policy steering it ten times a second from the mirror, exactly as a
 * player would see the arena. They carry an agent pass on the socket URL,
 * which the server honours only when it is signed with the game secret.
 * Bundled and run by rl/play.mjs.
 */
import { NetSession, type NetHooks } from "../src/game/net";
import { SKINS } from "../src/game/model";
import { DECISION_TICKS, OBS_DIM, TURNS, encodeObservation, reachOf } from "./env";
import { mintAgentPass } from "../game-server/src/agent-pass";

interface Weights {
  layers: { w: number[][]; b: number[] }[];
}

/** Ordinary nicknames, none of them a bot's. */
const NAMES = ["marlo", "vee", "kenji", "tova", "dax", "ines", "soren", "lyra", "bram", "nico"];
const AIM_REACH = 240;

/** In-memory Web Storage, one per client so each has its own device key. */
class Memory {
  private readonly map = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.map.set(k, v);
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

function forward(weights: Weights, x: Float32Array): number {
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

class Agent {
  readonly name: string;
  readonly net: NetSession;
  private readonly obs = new Float32Array(OBS_DIM);
  private lastDecision = 0;
  private action = 4;
  private aim = { x: 0, y: 0 };
  private boost = false;
  deaths = 0;
  kills = 0;
  best = 0;
  state = "connecting";

  constructor(
    index: number,
    url: string,
    private readonly weights: Weights,
  ) {
    this.name = NAMES[index % NAMES.length]! + (index >= NAMES.length ? String(index) : "");
    // The client reads its device key from localStorage as it is built.
    const g = globalThis as unknown as { localStorage: Memory; sessionStorage: Memory };
    g.localStorage = new Memory({
      "agencoil-device": `agent${index}${Math.random().toString(36).slice(2, 10)}`,
    });
    g.sessionStorage = new Memory();
    const look = { name: this.name, skin: index % 12, trail: 0, deathFx: 0 };
    const hooks: NetHooks = {
      onState: (s) => {
        this.state = s;
      },
      onSpawned: (s) => {
        this.aim = {
          x: s.x + Math.cos(s.angle) * AIM_REACH,
          y: s.y + Math.sin(s.angle) * AIM_REACH,
        };
      },
      onDeath: (d) => {
        if (d.nid === this.net.selfNid) {
          this.deaths++;
          // Back in after a moment, like a player pressing play again.
          setTimeout(() => this.net.play(look), 2500 + Math.random() * 2000);
        } else if (d.killerNid && d.killerNid === this.net.selfNid) this.kills++;
      },
      onEats: () => undefined,
      onStats: (s) => {
        if (s.mass > this.best) this.best = s.mass;
      },
      onProfile: () => undefined,
      onChallenges: () => undefined,
      onNear: () => undefined,
      onEvent: () => undefined,
      onNotice: () => undefined,
      onGateRequired: (m) => console.error(`${this.name}: gate: ${m}`),
      onAchieve: () => undefined,
      onEmote: () => undefined,
      onWisp: () => undefined,
      onHandle: () => undefined,
      onLeague: () => undefined,
    };
    this.net = new NetSession(url, hooks);
    this.net.connect();
    this.net.play(look);
  }

  tick(dt: number): void {
    const me = this.net.world.player;
    if (me) {
      const now = performance.now();
      if (now - this.lastDecision >= (DECISION_TICKS * 1000) / 40) {
        encodeObservation(this.net.world, me, this.obs, 0);
        this.action = forward(this.weights, this.obs);
        this.lastDecision = now;
      }
      const angle = me.angle + TURNS[this.action % TURNS.length]!;
      this.boost = this.action >= TURNS.length;
      this.aim = { x: me.x + Math.cos(angle) * AIM_REACH, y: me.y + Math.sin(angle) * AIM_REACH };
    }
    this.net.update(dt, this.aim, this.boost);
    if (me) {
      const r = reachOf(me.mass) + 200;
      this.net.sendInput(Math.atan2(this.aim.y - me.y, this.aim.x - me.x), this.boost, {
        cx: me.x,
        cy: me.y,
        hw: r,
        hh: r,
      });
    }
  }

  get alive(): boolean {
    return this.net.world.player !== undefined;
  }
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

const secret = process.env.GAME_SECRET ?? "";
if (!secret) {
  console.error("GAME_SECRET is needed to mint the agent pass");
  process.exit(1);
}
const count = Number(arg("agents", "10"));
const minutes = Number(arg("minutes", "180"));
const server = arg("url", "wss://agencoil-server.vercel.app/api/ws");
const weights = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(arg("weights", "rl/dist/watch/weights.json"), "utf8"),
) as Weights;
const url = `${server}${server.includes("?") ? "&" : "?"}agent=${encodeURIComponent(mintAgentPass(secret))}`;
console.log(`${count} agents for ${minutes} minutes on ${server}`);
const agents: Agent[] = [];
for (let i = 0; i < count; i++) {
  agents.push(new Agent(i, url, weights));
  // Spread the connections out a little.
  await new Promise((r) => setTimeout(r, 400));
}
let last = performance.now();
const loop = setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const a of agents) {
    try {
      a.tick(dt);
    } catch (err) {
      console.error(`${a.name}: tick failed:`, (err as Error)?.message ?? err);
    }
  }
}, 33);
const report = setInterval(() => {
  const alive = agents.filter((a) => a.alive).length;
  const online = agents.filter((a) => a.state === "online").length;
  const deaths = agents.reduce((n, a) => n + a.deaths, 0);
  const kills = agents.reduce((n, a) => n + a.kills, 0);
  const best = Math.max(...agents.map((a) => a.best));
  console.log(
    `${new Date().toISOString().slice(11, 19)} online ${online}/${count} alive ${alive} deaths ${deaths} kills ${kills} best ${Math.floor(best)} arena ${SKINS.length ? agents[0]?.net.arenaName : ""}`,
  );
}, 30_000);
setTimeout(() => {
  clearInterval(loop);
  clearInterval(report);
  for (const a of agents) a.net.close();
  console.log("done");
  setTimeout(() => process.exit(0), 500);
}, minutes * 60_000);
