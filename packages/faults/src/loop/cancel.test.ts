import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";
import { scriptedTerminal, term, type LoopWorld } from "./world.ts";
import { admissionState } from "../actor/admission.ts";

// D5 on the side of the actor, and cancellation at each point of a turn
// (guide 7.4): before the call is sent, during it, after the answer came but
// before it was written, with the operation prepared, with it running, while
// the user is asked, and after a restart. In every case the turn ends, no
// partial output is kept, and the next input works.

const sentBy = (w: LoopWorld, method: string) => w.link.sent.filter((m) => m.method === method);

/** Assistant rows that the model wrote, not the rows Hermes writes to close a stopped turn. */
const MODEL_ROWS = "role = 'assistant' AND display_kind IS NULL";

/** After a stop: the turn is over, nothing is pending, the transcript is valid. */
function assertStopped(w: LoopWorld): void {
  // As upstream: the stopped turn ends with an assistant row, a failed-turn notice or the hidden placeholder.
  const last = w.rows("messages").sort((a, b) => Number(a.id) - Number(b.id)).at(-1);
  if (last) assert.deepEqual([last.role, ["failed_turn", "hidden"].includes(String(last.display_kind))], ["assistant", true], "the stopped turn is closed");
  assert.equal(w.rows("turns")[0]!.status, "done");
  assert.equal(admissionState(w.rows("session_admissions")[0]!), "terminal:interrupted", "a stopped turn is recorded as interrupted, as upstream");
  assert.equal(w.rows("rt_admission_port")[0]!.result, "interrupted");
  assert.equal(w.replies.at(-1)!.text, "Stopped.");
  assert.equal(w.rows("pending_call", "status = 'pending'").length, 0);
  // An "outbox" obligation may still be open until the reply's outbox row is cleared.
  assert.equal(w.rows("wake_obligations", "state = 'open' AND kind != 'outbox'").length, 0);
  w.assertConsistent();
}

/** The next input is answered normally. */
async function assertNextInputWorks(w: LoopWorld, text: string): Promise<void> {
  const before = w.replies.length;
  await w.send("again");
  await w.until(() => w.replies.length === before + 1, "the reply to the next input");
  assert.equal(w.replies.at(-1)!.text, text);
  w.assertConsistent();
}

eachLoopWorld("cancellation at each point of a turn", (use) => {
  it(
    "before the call is sent: the request never leaves",
    use({ script: [{ reply: "unused" }, { reply: "second" }] }, async (w) => {
      w.b.onPoint({ actor: "s1", point: "fetch:before" }, async () => {
        await w.stop();
      });
      await w.send("hi");
      await w.until(() => w.replies.length === 1, "the stop reply");
      await w.b.settle();
      assert.equal(w.model.recorder.requests.length, 0);
      assert.equal(w.rows("pending_call")[0]!.status, "cancelled");
      assert.equal(w.rows("messages", MODEL_ROWS).length, 0);
      assertStopped(w);
      await assertNextInputWorks(w, "unused");
    }),
  );

  it(
    "during the call: the fetch is aborted and the partial output is dropped",
    use({ script: [{ hold: "g1", reply: "too late" }, { reply: "second" }] }, async (w) => {
      await w.send("hi");
      await w.until(() => w.model.recorder.requests.length === 1, "the request at the model");
      const r = (await w.stop()) as { stopped: boolean };
      assert.equal(r.stopped, true);
      await w.until(() => w.replies.length === 1, "the stop reply");
      assert.equal(w.model.aborted, 1, "the request was aborted");
      assert.equal(w.rows("messages", MODEL_ROWS).length, 0, "no partial output");
      assert.equal(w.rows("pending_call")[0]!.status, "cancelled");
      assertStopped(w);
      w.model.release("g1"); // the late answer has nobody to go to
      await assertNextInputWorks(w, "second");
    }),
  );

  it(
    "after the answer came and before it was written: the answer is dropped",
    use({ script: [{ reply: "dropped" }, { reply: "second" }] }, async (w) => {
      w.b.onPoint({ actor: "s1", point: "fetch:after" }, async () => {
        await w.stop();
      });
      await w.send("hi");
      await w.until(() => w.replies.length === 1, "the stop reply");
      assert.equal(w.model.recorder.requests.length, 1, "the model did answer");
      assert.equal(w.rows("messages", MODEL_ROWS).length, 0, "the answer was not written");
      assertStopped(w);
      await assertNextInputWorks(w, "second");
    }),
  );

  it(
    "with the operation prepared and not started: nothing runs and the operation is cancelled",
    use({ script: [{ toolCalls: [term({ stdout: "x" })] }, { reply: "second" }], loop: scriptedTerminal }, async (w) => {
      w.b.onPoint({ actor: "s1", point: "sidecar:after", detail: "executor.prepare" }, async () => {
        await w.stop();
      });
      await w.send("go");
      await w.until(() => w.replies.length === 1, "the stop reply");
      await w.b.settle();
      const op = w.rows("pending_op")[0]!;
      assert.equal(sentBy(w, "start").length, 0, "start was not sent after the stop");
      assert.equal(w.rig.runCount(op.op_id as never), 0);
      assert.equal(op.status, "cancelled");
      assert.equal(sentBy(w, "cancel").length, 1);
      const tool = w.rows("messages", "role = 'tool'");
      assert.equal(tool.length, 1, "the tool call has a result, so it is not split from its call");
      assertStopped(w);
    }),
  );

  it(
    "D5: while a tool runs, /stop ends the turn and sends cancel(op_id); the late result is accepted and discarded",
    use(
      { script: [{ toolCalls: [term({ hold: "h1", stdout: "late output" })] }, { reply: "second" }], loop: scriptedTerminal },
      async (w) => {
        await w.send("go");
        await w.until(() => sentBy(w, "start").length === 1, "the tool runs");
        await w.b.settle();
        const opId = w.rows("pending_op")[0]!.op_id as string;
        await w.stop();
        await w.until(() => w.replies.length === 1, "the stop reply");
        await w.b.settle();
        const cancels = sentBy(w, "cancel");
        assert.equal(cancels.length >= 1, true);
        assert.equal((cancels[0]!.args as unknown[])[0], opId);
        const op = w.rows("pending_op")[0]!;
        assert.equal(op.discard, 1);
        assert.equal(op.acked, 1, "the result was accepted at the executor");
        w.rig.commands.release("h1"); // the command function returns late
        await w.rig.settle();
        assert.equal(JSON.stringify(w.rows("messages", "role = 'tool'")).includes("late output"), false, "the late result was discarded");
        assertStopped(w);
        await assertNextInputWorks(w, "second");
      },
    ),
  );

  it(
    "D5: the result arrives just before the cancel: it is accepted and discarded, not recorded",
    use(
      { script: [{ toolCalls: [term({ hold: "h1", stdout: "raced output" })] }, { reply: "second" }], loop: scriptedTerminal },
      async (w) => {
        await w.send("go");
        await w.until(() => sentBy(w, "start").length === 1, "the tool runs");
        await w.b.settle();
        w.rig.commands.release("h1");
        await w.rig.settle(); // the command is done at the executor; the actor has not read it
        await w.stop();
        await w.until(() => w.replies.length === 1, "the stop reply");
        await w.b.settle();
        const op = w.rows("pending_op")[0]!;
        assert.equal(op.discard, 1);
        assert.equal(op.acked, 1);
        assert.equal(JSON.stringify(w.rows("messages", "role = 'tool'")).includes("raced output"), false);
        assertStopped(w);
      },
    ),
  );

  it(
    "while the user is asked: there is no turn to stop and the question stays",
    use(
      {
        script: [
          { toolCalls: [{ name: "clarify", arguments: { questions: [{ question: "Which?" }] } }] },
          { reply: "got it" },
        ],
      },
      async (w) => {
        await w.send("go");
        await w.until(() => w.replies.length === 1, "the question");
        const r = (await w.stop()) as { stopped: boolean };
        assert.equal(r.stopped, false);
        assert.equal(w.rows("clarify_question")[0]!.status, "open");
        await w.send("this one");
        await w.until(() => w.replies.length === 2, "the final reply");
        assert.equal(w.replies[1]!.text, "got it");
      },
    ),
  );

  it(
    "after a restart: the stop is a row, so the new activation sends the cancel again",
    use(
      { script: [{ toolCalls: [term({ hold: "h1" })] }, { reply: "second" }], loop: scriptedTerminal },
      async (w) => {
        await w.send("go");
        await w.until(() => sentBy(w, "start").length === 1, "the tool runs");
        await w.b.settle();
        // The actor dies after the stop was written and before cancel was sent.
        w.b.crashAt({ actor: "s1", point: "sidecar:before", detail: "executor.cancel" });
        await w.stop().catch(() => {});
        await w.b.settle();
        assert.equal(sentBy(w, "cancel").length, 0);
        assert.equal(w.rows("pending_op")[0]!.discard, 1, "the discard mark is durable");
        assert.equal(w.rows("pending_op")[0]!.acked, 0);
        // The next activation (any call) adopts it: the sweep cancels and accepts the result.
        await w.b.call("s1", "tail");
        await w.until(() => w.rows("pending_op")[0]!.acked === 1, "the late result is accepted");
        await w.until(() => w.replies.at(-1)?.text === "Stopped.", "the stop reply");
        assert.equal(sentBy(w, "cancel").length >= 1, true);
        assertStopped(w);
      },
    ),
  );
});
