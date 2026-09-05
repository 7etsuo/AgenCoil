import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import type { DailyBoard as DailyBoardT } from "./daily.ts";

// daily.ts has an extensionless import, so it is bundled the way the server build does.
const outDir = new URL("../dist/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `daily.test-${process.pid}.mjs`);
buildSync({
  entryPoints: [new URL("./daily.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: out,
  logLevel: "silent",
});
delete process.env.DATABASE_URL;
const { DailyBoard } = (await import(pathToFileURL(out).href)) as {
  DailyBoard: typeof DailyBoardT;
};
rmSync(out, { force: true });

test("the day's board keeps its top rows and lets a flood of names go", () => {
  const board = new DailyBoard();
  for (let i = 0; i < 6000; i++) board.record(`name-${i}`, i);
  const top = board.top(3);
  assert.deepEqual(
    top.map((e) => e.name),
    ["name-5999", "name-5998", "name-5997"],
  );
  const size = (board as unknown as { best: Map<string, number> }).best.size;
  assert.ok(size <= 4000, `names held: ${size}`);
  // A better run by a name that was let go comes back in.
  board.record("name-1", 7000);
  assert.equal(board.top(1)[0]!.name, "name-1");
});
