import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";
import { scriptedTerminal, term, tick } from "./world.ts";

// The NoLostMessage bug path of docs/statecharts/session-loop: a turn's model call is out,
// the user compacts, then the model answers. The answer must land in the current session,
// not in the parent that the compaction retired.

eachLoopWorld("compaction while a model call is out", (use) => {
  it(
    "the answer lands in the child session",
    use({ script: [{ reply: "first" }, { reply: "second", hold: "m" }] }, async (w) => {
      await w.send("hello");
      await w.until(() => w.replies.length === 1, "the first reply");
      await w.send("again");
      await w.until(() => w.model.recorder.requests.length === 2, "the second model call is out");
      const r = (await w.b.call("s1", "compact", { summary: "Summary." })) as { child: string };
      assert.ok(r.child);
      w.model.release("m");
      await w.until(() => w.replies.length === 2, "the second reply");
      const where = w.rows("messages", "role = 'assistant' AND content = 'second'").map((m) => `${m.session_id} active=${m.active}`);
      assert.deepEqual(where, [`${r.child} active=1`]);
      assert.deepEqual(await w.b.call("s1", "lineage_problems"), []);
      w.assertConsistent();
    }),
  );

  it(
    "a tool result read before the compact lands in the child session",
    use({ script: [{ toolCalls: [term({ hold: "h1", stdout: "late output" }, "call_a")] }, { reply: "all done" }], loop: scriptedTerminal }, async (w) => {
      await w.send("run it");
      await w.until(() => w.rows("pending_op").length > 0, "the pending terminal op");
      w.rig.commands.release("h1");
      await w.rig.settle();
      // Hold the next status read: the loop has read its snapshot and waits for the executor.
      const link = w.link as unknown as { status: (id: string) => Promise<unknown> };
      const status = link.status;
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      let waiting = false;
      link.status = async (id) => {
        waiting = true;
        await gate;
        return status(id);
      };
      void w.wakeAll();
      await w.until(() => waiting, "the status read is in flight");
      const r = (await w.b.call("s1", "compact", { summary: "Summary." })) as { child: string };
      link.status = status;
      open();
      await tick(20);
      await w.wakeAll();
      await w.until(() => w.replies.length === 1, "the reply");
      const where = w.rows("messages", "role = 'tool'").map((m) => `${m.session_id} active=${m.active}`);
      assert.deepEqual(where, [`${r.child} active=1`]);
      // The next model request is built from the child: the summary, then the call and its result.
      const body = w.model.recorder.requests.at(-1)!.body as { messages: Array<{ role: string; content: string | null }> };
      assert.deepEqual(body.messages.slice(1).map((m) => m.role), ["user", "assistant", "tool"]);
      assert.equal(body.messages[1]!.content, "Summary.");
      assert.deepEqual(await w.b.call("s1", "lineage_problems"), []);
      w.assertConsistent();
    }),
  );
});
