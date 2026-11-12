import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";

// The loop without faults: a plain reply and a turn with a terminal call.

eachLoopWorld("loop basics", (use) => {
  it(
    "answers a plain message",
    use({ script: [{ reply: "hello there" }] }, async (w) => {
      await w.send("hi");
      await w.until(() => w.replies.length === 1, "the reply");
      assert.equal(w.replies[0]!.text, "hello there");
      const msgs = w.rows("messages");
      assert.deepEqual(
        msgs.map((m) => m.role),
        ["user", "assistant"],
      );
      assert.equal(w.rows("pending_call")[0]!.status, "done");
      w.assertConsistent();
    }),
  );

  it(
    "leaves no timer once the turn is done and the outbox is sent",
    use({ script: [{ reply: "hello there" }] }, async (w) => {
      await w.send("hi");
      await w.until(() => w.replies.length === 1, "the reply");
      await w.until(() => w.rows("outbox").length === 0, "the outbox is empty");
      await w.b.settle();
      // No wake has fired: the closed obligation's timer was removed, not left to fire (and, on
      // Cloudflare or Rivet, to be re-armed by the adapter until someone disarms it).
      assert.equal(w.b.alarmOf("s1"), null, "a finished session stops waking");
      assert.deepEqual(w.rows("wake_obligations", "state = 'open'"), []);
    }),
  );

  it(
    "runs a terminal call through the executor and goes on",
    use(
      {
        script: [
          { toolCalls: [{ name: "terminal", arguments: { command: JSON.stringify({ stdout: "built" }) } }] },
          { reply: "it is built" },
        ],
        loop: { buildCommand: (a) => ({ argv: ["scripted", a.command] }) },
      },
      async (w) => {
        await w.send("build it");
        await w.until(() => w.replies.length === 1, "the reply");
        assert.equal(w.replies[0]!.text, "it is built");
        const tool = w.rows("messages", "role = 'tool'");
        assert.equal(tool.length, 1);
        assert.match(String(tool[0]!.content), /built/);
        const op = w.rows("pending_op")[0]!;
        assert.equal(op.status, "done");
        assert.equal(op.acked, 1);
        assert.equal(w.rig.runCount(op.op_id as never), 1);
        w.assertConsistent();
      },
    ),
  );
});
