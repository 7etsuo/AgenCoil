import test from "node:test";
import assert from "node:assert/strict";
import { retryDb } from "./db-retry.ts";

test("retries transient database failures", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await retryDb(
    async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "connected";
    },
    { attempts: 4, baseDelayMs: 10, sleep: async (ms) => void delays.push(ms) },
  );

  assert.equal(result, "connected");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("throws the final database error after exhausting retries", async () => {
  let calls = 0;
  await assert.rejects(
    retryDb(
      async () => {
        calls++;
        throw new Error(`failure-${calls}`);
      },
      { attempts: 3, baseDelayMs: 0, sleep: async () => undefined },
    ),
    /failure-3/,
  );
  assert.equal(calls, 3);
});
