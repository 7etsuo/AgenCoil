#!/usr/bin/env node
/**
 * Print the retention readout from the events table. Reads DATABASE_URL
 * directly, so it works without a running server.
 *
 *   DATABASE_URL=postgres://... node game-server/scripts/metrics.mjs        # last 7 days
 *   DATABASE_URL=postgres://... node game-server/scripts/metrics.mjs 30     # last 30 days
 *   DATABASE_URL=postgres://... node game-server/scripts/metrics.mjs 7 json # raw JSON
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const days = Math.min(90, Math.max(1, Number(process.argv[2]) || 7));
const asJson = process.argv[3] === "json";

// events.ts uses extensionless imports, so it is bundled the way the server is.
const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "agencoil-metrics-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, `export * from "${root}src/events.ts";`);
const out = join(dir, "events.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out });
const { runMetrics, formatMetrics } = await import(pathToFileURL(out).href);

const pool = new pg.Pool({
  connectionString: url,
  max: 2,
  ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: true } : undefined,
});
try {
  const m = await runMetrics(pool, days);
  console.log(asJson ? JSON.stringify(m, null, 2) : formatMetrics(m));
} finally {
  await pool.end();
}
