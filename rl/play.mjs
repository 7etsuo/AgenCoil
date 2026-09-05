// Put trained agents into a live arena as real clients. Usage:
//   AGENT_SECRET=... node rl/play.mjs [--agents 10] [--minutes 180] [--weights rl/dist/watch/weights.json] [--url wss://.../api/ws]
// AGENT_SECRET is the agencoil-server project's variable of that name (vercel env pull).
// The weights come from `python3 rl/export.py rl/runs/<run>/latest.pt <out.json>`.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require(join(here, "..", "game-server", "node_modules", "esbuild"));
const out = join(here, "dist", "agents.mjs");
await esbuild.build({
  entryPoints: [join(here, "agents.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
});
const child = spawn(process.execPath, [out, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
