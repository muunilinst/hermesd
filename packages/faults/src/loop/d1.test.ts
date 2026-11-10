import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";
import { tick, type LoopWorld } from "./world.ts";

// D1: shut the actor down during a model call: before, during, after the
// response. Rows are consistent, the pending_call completes (or the turn ends
// with a visible error), and the user gets no duplicate reply.

const assistantRows = (w: LoopWorld) => w.rows("messages", "role = 'assistant'");

function assertOneCleanReply(w: LoopWorld, text: string): void {
  assert.deepEqual(
    w.replies.map((r) => r.text),
    [text],
    "one reply",
  );
  assert.equal(assistantRows(w).length, 1, "one assistant message");
  assert.equal(w.rows("pending_call").length, 1);
  assert.equal(w.rows("pending_call")[0]!.status, "done");
  assert.equal(w.rows("session_admissions")[0]!.status, "done");
  w.assertConsistent();
}

eachLoopWorld("D1 shut down around the model call", (use) => {
  it(
    "before the request leaves: the pending call is re-sent once",
    use({ script: [{ reply: "hello" }] }, async (w) => {
      w.b.crashAt({ actor: "s1", point: "fetch:before" });
      await w.send("hi");
      await w.until(() => w.rows("pending_call").length === 1, "the pending call row");
      await w.b.settle();
      // The row is the position of the loop. The request never left.
      assert.equal(w.rows("pending_call")[0]!.status, "pending");
      assert.equal(w.rows("turns")[0]!.status, "open");
      assert.equal(w.rows("wake_obligations", "state = 'open'").length >= 1, true, "a wake obligation is open");
      assert.equal(w.model.recorder.requests.length, 0);
      assert.equal(w.replies.length, 0);

      await w.wakeAll();
      await w.until(() => w.replies.length === 1, "the reply after the wake");
      assert.equal(w.model.recorder.requests.length, 1);
      assertOneCleanReply(w, "hello");
    }),
  );

  it(
    "during the call: the same call_id is sent again and the answer is used once",
    use({ script: [{ hold: "g1", reply: "hello" }] }, async (w) => {
      await w.send("hi");
      await w.until(() => w.model.recorder.requests.length === 1, "the request at the model");
      w.b.crash("s1");
      w.model.release("g1"); // the answer goes nowhere: nobody receives it
      await tick();
      await w.b.settle();
      assert.equal(w.rows("pending_call")[0]!.status, "pending");
      assert.equal(assistantRows(w).length, 0, "the lost answer was not written");

      await w.wakeAll();
      await w.until(() => w.replies.length === 1, "the reply after the wake");
      const ids = w.model.recorder.requests.map((r) => r.callId);
      assert.equal(ids.length, 2);
      assert.equal(ids[0], ids[1], "a retry reuses the call_id");
      assertOneCleanReply(w, "hello");
    }),
  );

  it(
    "after the response, before the actor saw it: the call is re-driven",
    use({ script: [{ reply: "hello" }] }, async (w) => {
      w.b.crashAt({ actor: "s1", point: "fetch:after" });
      await w.send("hi");
      await w.until(() => w.model.recorder.requests.length === 1, "the request at the model");
      await w.b.settle();
      assert.equal(assistantRows(w).length, 0);
      await w.wakeAll();
      await w.until(() => w.replies.length === 1, "the reply after the wake");
      assert.equal(w.model.recorder.requests.length, 2);
      assertOneCleanReply(w, "hello");
    }),
  );

  it(
    "after the answer was committed, before the reply left: the reply comes once",
    use({ script: [{ reply: "hello" }] }, async (w) => {
      w.b.crashAt({ actor: "s1", point: "sidecar:before", detail: "gateway.deliver" });
      await w.send("hi");
      await w.until(() => assistantRows(w).length === 1, "the assistant message");
      await w.b.settle();
      assert.equal(w.replies.length, 0);
      assert.equal(w.rows("outbox").length >= 1, true, "the reply is an outbox row of the same commit");
      await w.b.call("s1", "flush_outbox", {});
      await w.b.settle();
      assertOneCleanReply(w, "hello");
      assert.equal(w.model.recorder.requests.length, 1, "the model was not asked again");
    }),
  );

  it(
    "after the gateway applied the reply, before the confirmation: sent twice, shown once",
    use({ script: [{ reply: "hello" }] }, async (w) => {
      w.b.crashAt({ actor: "s1", point: "sidecar:after", detail: "gateway.deliver" });
      await w.send("hi");
      await w.until(() => w.replies.length === 1, "the first delivery");
      await w.b.settle();
      await w.b.call("s1", "flush_outbox", {});
      await w.b.settle();
      assert.equal(w.deliveries, 2, "the gateway got the row twice");
      assertOneCleanReply(w, "hello");
    }),
  );

  it(
    "a 429 is retried at the next wake with the same call_id",
    use({ script: [{ status: 429, times: 1, reply: "hello" }] }, async (w) => {
      await w.send("hi");
      await w.until(() => w.model.recorder.requests.length === 1, "the first request");
      await w.b.settle();
      assert.equal(w.replies.length, 0);
      await w.wakeAll();
      await w.until(() => w.replies.length === 1, "the reply after the retry");
      const ids = w.model.recorder.requests.map((r) => r.callId);
      assert.equal(new Set(ids).size, 1);
      assert.equal(w.model.recorder.requests.length, 2);
      assertOneCleanReply(w, "hello");
    }),
  );

  it(
    "gives up after 3 retries with a visible error",
    use({ script: [{ status: 503 }] }, async (w) => {
      await w.send("hi");
      await w.until(() => w.model.recorder.requests.length === 1, "the first request");
      await w.b.settle();
      for (let i = 0; i < 8 && w.replies.length === 0; i++) {
        await w.wakeAll();
        await w.b.settle();
      }
      assert.equal(w.model.recorder.requests.length, 4, "one send and 3 retries");
      assert.equal(w.replies.length, 1);
      assert.match(w.replies[0]!.text, /^error: .*did not return after 3 retries|^error: the model returned HTTP/);
      assert.equal(w.rows("session_admissions")[0]!.status, "failed");
      assert.equal(w.rows("pending_call")[0]!.status, "failed");
      assert.equal(assistantRows(w).length, 0);
      w.assertConsistent();
    }),
  );
});
