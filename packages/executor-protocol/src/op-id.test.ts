import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveOpId } from "./op-id.ts";

describe("deriveOpId", () => {
  it("is stable for the same intent", async () => {
    const a = await deriveOpId("t1", "s1", "call_abc");
    assert.equal(await deriveOpId("t1", "s1", "call_abc"), a);
    assert.match(a, /^op_[0-9a-f]{64}$/);
  });

  it("changes when any field changes", async () => {
    const base = await deriveOpId("t1", "s1", "call_abc");
    assert.notEqual(await deriveOpId("t2", "s1", "call_abc"), base);
    assert.notEqual(await deriveOpId("t1", "s2", "call_abc"), base);
    assert.notEqual(await deriveOpId("t1", "s1", "call_abd"), base);
  });

  it("does not let field boundaries collide", async () => {
    assert.notEqual(await deriveOpId("a|b", "c", "d"), await deriveOpId("a", "b|c", "d"));
  });

  it("refuses empty fields", async () => {
    await assert.rejects(deriveOpId("", "s", "i"), TypeError);
  });
});
