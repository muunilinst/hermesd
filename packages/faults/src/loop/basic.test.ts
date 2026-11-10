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
