import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScriptedModel } from "./model/scripted.ts";
import { GOLDEN_FORMAT, compareGolden } from "./model/recorder.ts";

const call = (id: string) =>
  new Request("https://model.test/v1/chat/completions", {
    method: "POST",
    headers: { "idempotency-key": id, "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });

describe("ScriptedModel", () => {
  it("gives one step per call id, and the same answer on a re-send", async () => {
    const m = new ScriptedModel([{ reply: "one" }, { reply: "two" }]);
    const text = async (id: string) => ((await (await m.fetch(call(id))).json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
    assert.equal(await text("a"), "one");
    assert.equal(await text("a"), "one");
    assert.equal(await text("b"), "two");
    assert.equal(m.remaining, 0);
    assert.equal(m.recorder.requests.length, 3);
  });

  it("fails the first n requests of a step with the given status", async () => {
    const m = new ScriptedModel([{ status: 429, times: 1, reply: "ok" }]);
    assert.equal((await m.fetch(call("a"))).status, 429);
    assert.equal((await m.fetch(call("a"))).status, 200);
  });

  it("holds a request until release, and an abort ends the wait", async () => {
    const m = new ScriptedModel([{ hold: "g", reply: "late" }, { drop: true }]);
    const p = m.fetch(call("a"));
    m.release("g");
    assert.equal((await p).status, 200);
    const ac = new AbortController();
    const d = m.fetch(call("b"), ac.signal);
    ac.abort();
    await assert.rejects(d);
    assert.equal(m.aborted, 1);
  });
});

describe("golden record", () => {
  it("has a format tag and compares equal records as equal", () => {
    const m = new ScriptedModel([]);
    m.recorder.record({ callId: "x", method: "POST", path: "/v1/chat/completions", body: { a: 1 } });
    const rows = { messages: [], admissions: [] };
    const a = m.recorder.toGolden("s", rows);
    assert.equal(a.format, GOLDEN_FORMAT);
    assert.equal("callId" in a.requests[0]!, false);
    assert.deepEqual(compareGolden(a, m.recorder.toGolden("s", rows, "port")), []);
  });
});
