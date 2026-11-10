import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";
import { type LoopWorld } from "./world.ts";

// D7: shut down between writing the child session and marking the parent
// rows active=0. The lineage is repaired and no row is active in both the
// parent and the child.

async function oneTurn(w: LoopWorld): Promise<void> {
  await w.send("first question");
  await w.until(() => w.replies.length === 1, "the first reply");
}

const activeOf = (w: LoopWorld, session: string) => w.rows("messages", `session_id = '${session}' AND active = 1`);

eachLoopWorld("D7 shut down between the child session and the parent rows", (use) => {
  it(
    "the new activation finishes the compaction",
    use({ script: [{ reply: "first answer" }, { reply: "second answer" }] }, async (w) => {
      await oneTurn(w);
      // The second transaction of the compact call is the one that turns the parent rows inactive.
      w.b.crashAt({ actor: "s1", point: "tx:before", event: "call", method: "compact", nth: 2 });
      await w.b.call("s1", "compact", { summary: "Summary of the first exchange." }).catch(() => {});
      await w.b.settle();

      // The window: the child exists, the parent rows are still active.
      const link = w.rows("compaction_link")[0]!;
      assert.equal(link.status, "started");
      assert.equal(activeOf(w, "s1").length, 2, "the parent rows are still active");
      assert.equal(activeOf(w, link.child_id as string).length, 1, "the child has its summary");
      assert.equal(w.rows("sessions", `id = '${link.child_id}'`)[0]!.parent_session_id, "s1");

      // The next activation repairs it.
      await w.b.call("s1", "tail");
      await w.until(() => w.rows("compaction_link")[0]!.status === "done", "the link is done");
      assert.deepEqual(await w.b.call("s1", "lineage_problems"), []);
      assert.equal(activeOf(w, "s1").length, 0, "no parent row is active");
      assert.equal(w.rows("messages", "session_id = 's1' AND compacted = 1").length, 2);
      assert.equal(activeOf(w, link.child_id as string).length, 1);
      assert.equal(w.rows("sessions", "id = 's1'")[0]!.end_reason, "compression");

      // The loop goes on in the child: the model sees the summary and the new input, not the old rows.
      await w.send("second question");
      await w.until(() => w.replies.length === 2, "the second reply");
      const body = w.model.recorder.requests.at(-1)!.body as { messages: Array<{ role: string; content: string }> };
      assert.deepEqual(
        body.messages.map((m) => m.content).slice(1),
        ["Summary of the first exchange.", "second question"],
      );
      assert.equal(w.rows("messages", `session_id = '${link.child_id}' AND role = 'assistant'`).length, 1);
      w.assertConsistent();
    }),
  );

  it(
    "the repair can run twice and a finished compaction is left alone",
    use({ script: [{ reply: "first answer" }] }, async (w) => {
      await oneTurn(w);
      await w.b.call("s1", "compact", { summary: "S" });
      const before = JSON.stringify(w.rows("messages"));
      w.b.crash("s1");
      await w.b.call("s1", "tail");
      await w.b.settle();
      assert.equal(JSON.stringify(w.rows("messages")), before);
      assert.deepEqual(await w.b.call("s1", "lineage_problems"), []);
    }),
  );
});
