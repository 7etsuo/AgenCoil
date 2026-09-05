import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickHandle, toHandle } from "./handle.ts";

describe("toHandle", () => {
  it("lower-cases, joins words with underscores and drops the rest", () => {
    assert.equal(toHandle("Circles (Mike)"), "circles_mike");
    assert.equal(toHandle("Robert - Eno"), "robert_eno");
    assert.equal(toHandle("@Tetsuo"), "tetsuo");
    assert.equal(toHandle("a"), "", "one character is not a handle");
    assert.equal(toHandle("日本語"), "", "nothing left after the filter");
    assert.equal(toHandle("x".repeat(20)).length, 15, "cut to X's limit");
  });
});

describe("pickHandle", () => {
  it("never takes the handle from the email, whose local part is the X user id", () => {
    const p = pickHandle({
      id: "u1",
      name: "Robert - Eno",
      ...({ email: "3098700091@x.grok.me" } as object),
    });
    assert.deepEqual(p, { handle: "robert_eno", from: "name" });
  });

  it("nor from a real mailbox address, which is private", () => {
    const p = pickHandle({
      id: "u2",
      name: "Mike",
      ...({ email: "mike.r@company.com" } as object),
    });
    assert.deepEqual(p, { handle: "mike", from: "name" });
  });

  it("prefers a username column when the broker provides one", () => {
    assert.deepEqual(pickHandle({ id: "u3", name: "Robert - Eno", username: "RobEno" }), {
      handle: "robeno",
      from: "username",
    });
    assert.deepEqual(pickHandle({ id: "u3", name: "Robert - Eno", displayUsername: "Rob_E" }), {
      handle: "rob_e",
      from: "username",
    });
  });

  it("falls back to a stable id-based handle when the name gives nothing", () => {
    assert.deepEqual(pickHandle({ id: "user_ABCDEF123456", name: "日本語" }), {
      handle: "player_ef123456",
      from: "id",
    });
    assert.deepEqual(pickHandle({ id: "u5", name: null }), { handle: "player_u5", from: "id" });
  });
});
