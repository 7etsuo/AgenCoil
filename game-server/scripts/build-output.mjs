// Produce a Vercel Build Output (v3) directory for the arena server.
//
// Vercel discovers `api/` functions from source before the build command
// runs, so a function bundled at build time is never picked up. Writing the
// output directory ourselves sidesteps that: one self-contained function at
// /api/ws plus the static status page.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel", "output");
const fn = join(out, "functions", "api", "ws.func");

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });
mkdirSync(join(out, "static"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "vercel-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(fn, "index.mjs"),
  external: ["pg-native"],
  // CommonJS dependencies (ws, pg) need a `require` when bundled into ESM.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  logLevel: "info",
});

writeFileSync(
  join(fn, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      maxDuration: 800,
      regions: ["iad1"],
    },
    null,
    2,
  ),
);

writeFileSync(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/(.*)", headers: { "Access-Control-Allow-Origin": "*" }, continue: true },
        { handle: "filesystem" },
        { src: "/api/play-ticket", dest: "/api/ws" },
        { src: "/api/arena", dest: "/api/ws" },
        { src: "/api/drain", dest: "/api/ws" },
        { src: "/api/ws", dest: "/api/ws" },
      ],
      // Keep the arena rolled over before its Sandbox session ends.
      crons: [{ path: "/api/arena?tick=1", schedule: "*/10 * * * *" }],
    },
    null,
    2,
  ),
);

cpSync(join(root, "public"), join(out, "static"), { recursive: true });
console.log("[build-output] wrote", out);
