import assert from "node:assert/strict";
import { it } from "node:test";
import type { OpId } from "@hermesd/executor-protocol";
import { eachLoopWorld } from "./test-util.ts";
import { scriptedTerminal, term, tick, type LoopWorld } from "./world.ts";

// D2, D10, D13 and D17 from the side of the session actor, the persistence
// rules of the loop, parallel and sequential tools, and the unknown outcome.
// "One run" is read from the counter of the simulated guest, not from the cell.

const opIdOf = (w: LoopWorld, i = 0): OpId => w.rows("pending_op")[i]!.op_id as OpId;
const sentBy = (w: LoopWorld, method: string) => w.link.sent.filter((m) => m.method === method);
const toolText = (w: LoopWorld): string[] => w.rows("messages", "role = 'tool'").map((m) => String(m.content));

eachLoopWorld("session actor and executor handoffs", (use) => {
  it(
    "D2: the actor dies after start was sent; the new owner fences, adopts, reads the status; one run",
    use(
      { script: [{ toolCalls: [term({ hold: "h1", stdout: "out" })] }, { reply: "done" }], loop: scriptedTerminal },
      async (w) => {
        w.b.crashAt({ actor: "s1", point: "sidecar:after", detail: "executor.start" });
        await w.send("go");
        await w.until(() => sentBy(w, "start").length === 1, "start was sent");
        await w.b.settle();
        const opId = opIdOf(w);
        const oldEpoch = w.b.epochOf("s1");
        assert.equal(w.rows("pending_op")[0]!.status, "pending", "the actor never saw the answer of start");
        w.rig.commands.release("h1");
        await w.rig.settle();

        await w.wakeAll();
        await w.until(() => w.replies.length === 1, "the reply after the takeover");
        const newEpoch = w.b.epochOf("s1");
        assert.equal(newEpoch > oldEpoch, true);
        const fences = sentBy(w, "fence");
        assert.equal(fences.length >= 1, true);
        assert.deepEqual(fences.at(-1)!.args, ["s1", newEpoch], "the new owner fenced with its epoch");
        assert.equal(w.rig.cell.inspect().minEpoch.get("s1"), newEpoch);
        assert.equal(w.rig.runCount(opId), 1, "the command ran once");
        assert.equal(sentBy(w, "start").length, 1, "the new owner read the status; it did not start again");
        assert.match(toolText(w)[0]!, /out/);
        assert.equal(w.rows("pending_op")[0]!.status, "done");
        w.assertConsistent();
      },
    ),
  );

  it(
    "D2: the command is still running at takeover; the new owner waits and takes the result from an event",
    use(
      { script: [{ toolCalls: [term({ hold: "h1", stdout: "late" })] }, { reply: "done" }], loop: scriptedTerminal },
      async (w) => {
        await w.send("go");
        await w.until(() => sentBy(w, "start").length === 1, "start was sent");
        await w.b.settle();
        w.b.crash("s1");
        await w.wakeAll();
        await w.b.settle();
        assert.equal(w.rows("pending_op")[0]!.status, "pending", "still running: nothing is recorded");
        assert.equal(w.replies.length, 0);
        w.rig.commands.release("h1");
        await w.rig.settle();
        await w.b.call("s1", "op_event", {}); // the result event
        await w.until(() => w.replies.length === 1, "the reply after the event");
        assert.equal(w.rig.runCount(opIdOf(w)), 1);
        assert.match(toolText(w)[0]!, /late/);
        w.assertConsistent();
      },
    ),
  );

  it(
    "D10: crash after the network send of start; the retry reuses the op_id; a copy of start is a duplicate; one run",
    use(
      { script: [{ toolCalls: [term({ stdout: "x" })] }, { reply: "done" }], loop: scriptedTerminal },
      async (w) => {
        w.b.crashAt({ actor: "s1", point: "sidecar:after", detail: "executor.start" });
        await w.send("go");
        await w.until(() => sentBy(w, "start").length === 1, "start was sent");
        await w.b.settle();
        const opId = opIdOf(w);
        const firstStart = sentBy(w, "start")[0]!;
        await w.wakeAll();
        await w.until(() => w.replies.length === 1, "the reply");
        // Every executor message about this operation names the same op_id.
        const named = w.link.sent.flatMap((m) => {
          const a = m.args[0] as { opId?: string } | string;
          return typeof a === "string" ? (a.startsWith("op_") ? [a] : []) : a?.opId ? [a.opId] : [];
        });
        assert.equal(new Set(named).size, 1);
        assert.equal(named[0], opId);
        // The network delivers a copy of the old start. It carries the old epoch: refused.
        assert.deepEqual(await w.link.copy(firstStart.index).deliver(), { kind: "stale_epoch" });
        // A start from the current owner is deduplicated by the executor.
        const again = (await w.link.start(opId, w.b.epochOf("s1"))) as { kind: string };
        assert.equal(again.kind, "duplicate");
        assert.equal(w.rig.runCount(opId), 1);
      },
    ),
  );

  it(
    "D17: owner 7 prepared and crashed before start; owner 8 starts it once; a late call of owner 7 is stale_epoch",
    use(
      { script: [{ toolCalls: [term({ stdout: "x" })] }, { reply: "done" }], loop: scriptedTerminal },
      async (w) => {
        w.b.crashAt({ actor: "s1", point: "sidecar:before", detail: "executor.start" });
        await w.send("go");
        await w.until(() => sentBy(w, "prepare").length === 1, "prepare was sent");
        await w.b.settle();
        const opId = opIdOf(w);
        const owner7 = w.b.epochOf("s1");
        assert.equal(sentBy(w, "start").length, 0, "start was never sent");
        assert.equal(w.rig.cell.inspect().ops.get(opId)!.status.status, "prepared");
        assert.equal(w.rig.runCount(opId), 0);

        await w.wakeAll();
        await w.until(() => w.replies.length === 1, "the reply");
        const owner8 = w.b.epochOf("s1");
        assert.equal(owner8 > owner7, true);
        assert.deepEqual(sentBy(w, "start").map((m) => m.args), [[opId, owner8]], "owner 8 started it with its own epoch");
        assert.equal(w.rig.runCount(opId), 1);
        assert.deepEqual(await w.link.start(opId, owner7), { kind: "stale_epoch" });
        assert.equal(w.rig.runCount(opId), 1);
      },
    ),
  );

  it(
    "D13: an old owner's command keeps running; the new owner fences first and settles it before its own start",
    use(
      {
        script: [{ toolCalls: [term({ hold: "h1", stdout: "first" })] }, { toolCalls: [term({ stdout: "second" })] }, { reply: "done" }],
        loop: scriptedTerminal,
      },
      async (w) => {
        await w.send("go");
        await w.until(() => sentBy(w, "start").length === 1, "the first start");
        await w.b.settle();
        const first = opIdOf(w);
        const owner7 = w.b.epochOf("s1");
        w.b.crash("s1");
        await w.wakeAll();
        await w.b.settle();
        const owner8 = w.b.epochOf("s1");
        const fenceAt = sentBy(w, "fence").find((m) => (m.args[1] as number) === owner8)!.index;
        assert.equal(w.rig.cell.inspect().minEpoch.get("s1"), owner8);
        assert.deepEqual(await w.link.start(first, owner7), { kind: "stale_epoch" });
        assert.equal(w.rows("pending_op").length, 1, "no second operation before the first is settled");
        w.rig.commands.release("h1");
        await w.rig.settle();
        await w.b.call("s1", "op_event", {});
        await w.until(() => w.replies.length === 1, "the reply");
        const second = opIdOf(w, 1);
        const prepareSecond = sentBy(w, "prepare").find((m) => (m.args[0] as { opId: string }).opId === second)!;
        assert.equal(fenceAt < prepareSecond.index, true, "the fence came before the next operation of the new owner");
        assert.equal(w.rig.runCount(first), 1);
        assert.equal(w.rig.runCount(second), 1);
        assert.deepEqual(
          toolText(w).map((t) => (JSON.parse(t) as { output: string }).output),
          ["first", "second"],
        );
        w.assertConsistent();
      },
    ),
  );

  it(
    "persist before execute: the tool-call turn and the pending_op row are durable before prepare is sent",
    use({ script: [{ toolCalls: [term({ stdout: "x" })] }, { reply: "done" }], loop: scriptedTerminal }, async (w) => {
      const seen: Array<{ assistantWithCalls: number; ops: number }> = [];
      w.b.onPoint({ actor: "s1", point: "sidecar:before", detail: "executor.prepare" }, () => {
        seen.push({
          assistantWithCalls: w.rows("messages", "role = 'assistant' AND tool_calls IS NOT NULL").length,
          ops: w.rows("pending_op").length,
        });
      });
      await w.send("go");
      await w.until(() => w.replies.length === 1, "the reply");
      assert.deepEqual(seen, [{ assistantWithCalls: 1, ops: 1 }]);
      const op = w.rows("pending_op")[0]!;
      assert.equal(op.incarnation, w.rig.cell.inspect().incarnation, "the incarnation from describe is stored once");
      assert.equal(sentBy(w, "describe").length, 1);
    }),
  );

  it(
    "a persistence failure before tool execution ends the turn and runs no tool",
    use({ script: [{ toolCalls: [term({ stdout: "x" })] }, { reply: "never" }], loop: scriptedTerminal }, async (w) => {
      // After the model answered, the next write fails once.
      w.b.onPoint({ actor: "s1", point: "fetch:after" }, () => {
        w.b.onPoint({ actor: "s1", point: "tx:before" }, () => {
          throw new Error("disk full");
        });
      });
      await w.send("go");
      await w.until(() => w.replies.length === 1, "the visible error");
      assert.match(w.replies[0]!.text, /^error: session_persistence_failed/);
      assert.equal(sentBy(w, "prepare").length + sentBy(w, "start").length, 0, "the executor saw no operation");
      assert.equal(w.rig.guest.totalRuns(), 0, "no tool ran");
      assert.equal(w.rows("pending_op").length, 0);
      assert.equal(w.rows("messages", "role = 'assistant'").length, 0, "the failed write left nothing behind");
      assert.equal(w.rows("session_admissions")[0]!.status, "failed");
      w.assertConsistent();
    }),
  );

  it(
    "parallel tools: one pending_op each, results in the order of the calls",
    use(
      {
        script: [{ toolCalls: [term({ hold: "a", stdout: "A" }), term({ hold: "b", stdout: "B" })] }, { reply: "both" }],
        loop: scriptedTerminal,
      },
      async (w) => {
        await w.send("go");
        await w.until(() => sentBy(w, "start").length === 2, "both started");
        assert.equal(w.rows("pending_op").length, 2);
        w.rig.commands.release("b"); // the second finishes first
        await tick(10); // not rig.settle(): the first command is still held
        await w.b.call("s1", "op_event", {});
        await w.b.settle();
        assert.equal(toolText(w).length, 0, "a result waits for the calls before it");
        w.rig.commands.release("a");
        await w.rig.settle();
        await w.b.call("s1", "op_event", {});
        await w.until(() => w.replies.length === 1, "the reply");
        assert.deepEqual(
          toolText(w).map((t) => (JSON.parse(t) as { output: string }).output),
          ["A", "B"],
        );
        assert.equal(w.model.recorder.requests.length, 2, "one model call for both results");
        w.assertConsistent();
      },
    ),
  );

  it(
    "unknown outcome: the admission becomes unknown, the user is asked, later inputs wait",
    use(
      {
        script: [{ toolCalls: [term({ hold: "h1" })] }, { reply: "after the answer" }],
        loop: scriptedTerminal,
      },
      async (w) => {
        await w.send("go");
        await w.until(() => sentBy(w, "start").length === 1, "start was sent");
        await w.b.settle();
        // A stop and a start of the VM: a command that was running has no exit status.
        await w.rig.cell.stopVm();
        await w.rig.cell.startVm();
        await w.b.call("s1", "op_event", {});
        await w.until(() => w.rows("session_admissions")[0]!.status === "unknown", "the admission is unknown");
        await w.until(() => w.replies.length === 1, "the question to the user");
        assert.match(w.replies[0]!.text, /may or may not have run/);
        assert.equal(w.rows("turns")[0]!.status, "unknown");
        assert.equal(w.rows("pending_op")[0]!.status, "unknown");
        w.assertConsistent();

        // A later input waits. Nothing starts, the model is not called.
        await w.send("next");
        await w.b.settle();
        await tick();
        assert.equal(w.rows("session_admissions", "status = 'queued'").length, 1);
        assert.equal(w.model.recorder.requests.length, 1);

        // The user resolves it. Then the queued input runs.
        await w.b.call("s1", "resolve_unknown", { note: "checked, it did not run" });
        await w.until(() => w.replies.length === 2, "the reply to the later input");
        assert.equal(w.replies[1]!.text, "after the answer");
        w.assertConsistent();
      },
    ),
  );

  it(
    "expired: after a restore the stored incarnation is refused and the outcome is unknown",
    use({ script: [{ toolCalls: [term({ stdout: "x" })] }, { reply: "never" }], loop: scriptedTerminal }, async (w) => {
      w.b.crashAt({ actor: "s1", point: "sidecar:before", detail: "executor.prepare" });
      await w.send("go");
      await w.until(() => w.rows("pending_op").length === 1, "the pending_op row");
      await w.b.settle();
      const stored = w.rows("pending_op")[0]!.incarnation as number;
      // The workspace is restored from an older save: a new incarnation starts.
      await w.rig.cell.stopVm();
      await w.rig.cell.restoreDisks("save-1");
      await w.rig.cell.startVm();
      assert.equal(w.rig.cell.inspect().incarnation > stored, true);
      await w.wakeAll();
      await w.until(() => w.rows("session_admissions")[0]!.status === "unknown", "unknown");
      const prepares = sentBy(w, "prepare");
      assert.equal((prepares.at(-1)!.args[0] as { incarnation: number }).incarnation, stored, "the retry used the stored incarnation");
      assert.equal(w.rig.guest.totalRuns(), 0, "nothing ran");
      assert.equal(sentBy(w, "start").length, 0);
    }),
  );

  it(
    "clarify forces the tools of a batch to run one at a time, in order",
    use(
      {
        script: [
          {
            toolCalls: [
              term({ stdout: "A" }, "c1"),
              { name: "clarify", arguments: { questions: [{ question: "Which colour?", choices: ["red", "blue"] }] }, id: "c2" },
              term({ stdout: "B" }, "c3"),
            ],
          },
          { reply: "all done" },
        ],
        loop: scriptedTerminal,
      },
      async (w) => {
        await w.send("go");
        await w.until(() => w.replies.length === 1, "the question");
        assert.match(w.replies[0]!.text, /Which colour\?/);
        assert.equal(w.rows("pending_op").length, 1, "the third call did not start before the answer");
        assert.equal(w.rows("clarify_question")[0]!.status, "open");
        assert.equal(w.rows("session_admissions")[0]!.status, "done", "the turn ended and waits for the user");
        assert.equal(w.rows("turns", "status = 'open'").length, 0);
        w.assertConsistent();

        await w.send("blue");
        await w.until(() => w.replies.length === 2, "the final reply");
        assert.equal(w.replies[1]!.text, "all done");
        assert.equal(w.rows("pending_op").length, 2);
        const roles = w.rows("messages").map((m) => `${m.role}:${m.tool_call_id ?? ""}`);
        assert.deepEqual(roles, ["user:", "assistant:", "tool:c1", "tool:c2", "tool:c3", "assistant:"]);
        const answer = JSON.parse(String(w.rows("messages", "tool_call_id = 'c2'")[0]!.content)) as { responses: Array<{ user_response: string }> };
        assert.equal(answer.responses[0]!.user_response, "blue");
        w.assertConsistent();
      },
    ),
  );

  it(
    "todo is agent-internal: the rows change in the same commit as the tool-call turn",
    use(
      {
        script: [
          { toolCalls: [{ name: "todo_list", arguments: { todos: [{ id: "1", content: "write", status: "in_progress" }] } }] },
          { reply: "listed" },
        ],
      },
      async (w) => {
        await w.send("plan");
        await w.until(() => w.replies.length === 1, "the reply");
        assert.equal(w.rows("todo_item").length, 1);
        assert.equal(sentBy(w, "prepare").length, 0, "no executor call for an internal tool");
        const result = JSON.parse(toolText(w)[0]!) as { summary: { in_progress: number } };
        assert.equal(result.summary.in_progress, 1);
        assert.equal(w.rows("todo_item")[0]!.schema_version, 32);
        w.assertConsistent();
      },
    ),
  );
});
