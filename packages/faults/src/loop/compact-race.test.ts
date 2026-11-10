import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";

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
});
