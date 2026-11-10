import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";
import { scriptedTerminal, term, type LoopWorld } from "./world.ts";

// Compaction while a tool call has no result yet. The unanswered assistant row
// is not replaced by the summary, so the child session must carry it (upstream
// keeps a protected tail). The result that arrives later then lands in the
// child, next to its call. No row is active in both sessions (D7).

const SCRIPT = [{ toolCalls: [term({ hold: "h1", stdout: "late output" }, "call_a")] }, { reply: "all done" }];
const activeOf = (w: LoopWorld, session: string) => w.rows("messages", `session_id = '${session}' AND active = 1`);

/** Send the first input and wait until the terminal operation exists but has not finished. */
async function startPending(w: LoopWorld): Promise<void> {
  await w.send("run it");
  await w.until(() => w.rows("pending_op").length > 0, "the pending terminal op");
}

/** After the result came: the model saw the call followed by its result, in the child session. */
async function finish(w: LoopWorld, child: string): Promise<void> {
  w.rig.commands.release("h1");
  await w.rig.settle();
  await w.wakeAll();
  await w.until(() => w.replies.length === 1, "the reply");
  assert.equal(w.replies[0]!.text, "all done");
  const body = w.model.recorder.requests.at(-1)!.body as { messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string }>; tool_call_id?: string }> };
  const seen = body.messages.slice(1);
  assert.deepEqual(seen.map((m) => m.role), ["user", "assistant", "tool"]);
  assert.equal(seen[0]!.content, "Summary of the first part.");
  assert.equal(seen[1]!.tool_calls![0]!.id, "call_a");
  assert.equal(seen[2]!.tool_call_id, "call_a");
  assert.match(String(seen[2]!.content), /late output/);
  // The call and its result are in the child. The parent keeps nothing active.
  assert.deepEqual(activeOf(w, "s1"), []);
  assert.deepEqual(activeOf(w, child).map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.deepEqual(await w.b.call("s1", "lineage_problems"), []);
  w.assertConsistent();
}

eachLoopWorld("compaction with an outstanding tool call", (use) => {
  it(
    "the child carries the unanswered call and the result lands next to it",
    use({ script: SCRIPT, loop: scriptedTerminal }, async (w) => {
      await startPending(w);
      const r = (await w.b.call("s1", "compact", { summary: "Summary of the first part." })) as { child: string };
      assert.ok(r.child, "a child session was made");
      assert.equal(w.rows("compaction_link")[0]!.status, "done");
      assert.deepEqual(activeOf(w, r.child).map((m) => m.role), ["user", "assistant"], "summary, then the call");
      await finish(w, r.child);
    }),
  );

  it(
    "a crash between the two commits is repaired and the pairing holds",
    use({ script: SCRIPT, loop: scriptedTerminal }, async (w) => {
      await startPending(w);
      w.b.crashAt({ actor: "s1", point: "tx:before", event: "call", method: "compact", nth: 2 });
      await w.b.call("s1", "compact", { summary: "Summary of the first part." }).catch(() => {});
      await w.b.settle();
      const link = w.rows("compaction_link")[0]!;
      assert.equal(link.status, "started");
      const child = link.child_id as string;
      assert.deepEqual(activeOf(w, child).map((m) => m.role), ["user", "assistant"]);
      // Wake the actor: it repairs the lineage.
      await w.b.call("s1", "tail");
      await w.until(() => w.rows("compaction_link")[0]!.status === "done", "the link is done");
      await finish(w, child);
    }),
  );
});
