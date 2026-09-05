// Bundle the environment server and its worker with esbuild, then run it.
// Usage: node rl/run.mjs [--workers 32] [--agents 8] [--bots 50] [--port 5555]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  esbuild = require(join(here, "..", "game-server", "node_modules", "esbuild"));
}
const out = join(here, "dist");
for (const name of ["server", "worker"]) {
  await esbuild.build({
    entryPoints: [join(here, `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(out, `${name}.mjs`),
    logLevel: "silent",
  });
}
const child = spawn(process.execPath, [join(out, "server.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, RL_WORKER: join(out, "worker.mjs") },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
