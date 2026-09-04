import assert from "node:assert/strict";
import { test } from "node:test";
import { IdentityGate, cleanHandle } from "./identity.ts";

test("only https origins on the allowlist may vouch for a player", () => {
  const g = new IdentityGate(["snek.grok.me", "*.grok-sandbox.com", "localhost"]);
  assert.equal(g.allows("https://snek.grok.me"), true);
  assert.equal(g.allows("https://abc.grok-sandbox.com"), true);
  assert.equal(g.allows("http://localhost:8080"), true);
  assert.equal(g.allows("http://snek.grok.me"), false);
  assert.equal(g.allows("https://evil.example"), false);
  assert.equal(g.allows("https://snek.grok.me.evil.example"), false);
  assert.equal(g.allows("not a url"), false);
});

test("redeem asks the site and cleans what comes back", async () => {
  const calls: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        ok: true,
        sub: "u_1",
        handle: "@Tetsuo!",
        name: "Tetsuo",
        avatar: "https://x/a.png",
      }),
    );
  }) as typeof fetch;
  const g = new IdentityGate(["snek.grok.me"], fake);
  const id = await g.redeem("https://snek.grok.me", "a".repeat(32));
  assert.deepEqual(id, { sub: "u_1", handle: "tetsuo", name: "Tetsuo", avatar: "https://x/a.png" });
  assert.equal(calls[0], `https://snek.grok.me/api/identity/redeem?t=${"a".repeat(32)}`);
  // Refused origin: no call at all.
  assert.equal(await g.redeem("https://evil.example", "a".repeat(32)), null);
  assert.equal(calls.length, 1);
});

test("a 404 or a bad body is not an identity", async () => {
  const g404 = new IdentityGate(
    ["s"],
    (async () => new Response("", { status: 404 })) as typeof fetch,
  );
  assert.equal(await g404.redeem("https://s", "b".repeat(20)), null);
  const gBad = new IdentityGate(
    ["s"],
    (async () => new Response(JSON.stringify({ ok: true, sub: "x", handle: "!" }))) as typeof fetch,
  );
  assert.equal(await gBad.redeem("https://s", "b".repeat(20)), null);
});

test("handles are lower-case [a-z0-9_] between 2 and 15", () => {
  assert.equal(cleanHandle("@Elon_Musk"), "elon_musk");
  assert.equal(cleanHandle("a"), "");
  assert.equal(cleanHandle("x".repeat(30)), "x".repeat(15));
});
