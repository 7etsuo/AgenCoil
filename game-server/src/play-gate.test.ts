import assert from "node:assert/strict";
import { test } from "node:test";
import { PlayGate } from "./play-gate.ts";

const okFetch = (hostname = "mmo.agenc.ag", action = "play") =>
  (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("secret"), "turnstile-secret");
    assert.equal(body.get("response"), "browser-token");
    assert.equal(body.get("remoteip"), "203.0.113.10");
    return Response.json({ success: true, hostname, action });
  }) as typeof fetch;

test("issues an IP-bound, single-use ticket and grants a session", async () => {
  let now = 1_000_000;
  const gate = new PlayGate({
    secret: "turnstile-secret",
    signingSecret: "game-secret",
    allowedHostnames: ["mmo.agenc.ag"],
    fetchImpl: okFetch(),
    now: () => now,
  });

  const issued = await gate.issue("browser-token", "203.0.113.10");
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.equal(gate.redeem(issued.ticket, "198.51.100.4"), null, "ticket stays IP-bound");
  assert.equal(gate.redeem(issued.ticket, "203.0.113.10"), now + 30 * 60_000);
  assert.equal(gate.redeem(issued.ticket, "203.0.113.10"), null, "ticket cannot be replayed");

  const second = await gate.issue("browser-token", "203.0.113.10");
  assert.equal(second.ok, true);
  if (!second.ok) return;
  now += 60_001;
  assert.equal(gate.redeem(second.ticket, "203.0.113.10"), null, "expired ticket is rejected");
});

test("rejects a Siteverify action or hostname mismatch", async () => {
  for (const fetchImpl of [okFetch("other.example"), okFetch("mmo.agenc.ag", "contact")]) {
    const gate = new PlayGate({
      secret: "turnstile-secret",
      signingSecret: "game-secret",
      allowedHostnames: ["mmo.agenc.ag"],
      fetchImpl,
    });
    const result = await gate.issue("browser-token", "203.0.113.10");
    assert.deepEqual(result, {
      ok: false,
      status: 403,
      error: "Human verification failed. Please try again.",
    });
  }
});

test("rate limits Siteverify exchanges per IP", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return Response.json({ success: true, hostname: "mmo.agenc.ag", action: "play" });
  }) as typeof fetch;
  const gate = new PlayGate({
    secret: "turnstile-secret",
    signingSecret: "game-secret",
    allowedHostnames: ["mmo.agenc.ag"],
    fetchImpl,
    attemptsPerMinute: 1,
  });

  assert.equal((await gate.issue("first", "203.0.113.10")).ok, true);
  const limited = await gate.issue("second", "203.0.113.10");
  assert.equal(limited.ok, false);
  if (limited.ok) return;
  assert.equal(limited.status, 429);
  assert.equal(calls, 1);
});

test("stays disabled when no server secret is configured", async () => {
  const gate = new PlayGate({ signingSecret: "game-secret" });
  const issued = await gate.issue("", "203.0.113.10");
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.equal(issued.ticket, "");
  assert.equal(gate.redeem("", "203.0.113.10"), Number.POSITIVE_INFINITY);
});
