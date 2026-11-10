import assert from "node:assert/strict";
import { it } from "node:test";
import { type MigrationSet } from "@hermesd/session-actor";
import { eachLoopWorld } from "./test-util.ts";

// Guide 7.4, upgrade tests: deploy a new port version while a session waits
// on clarify. The answer must complete under the new code with the old rows.
// The policy: every row carries schema_version, and a migration is a
// forward-only function per version that runs on first read.

/** "New code": schema version 33. It adds a field to the clarify rows and renames one in the turn rows. */
const V33: MigrationSet = {
  current: 33,
  steps: {
    32: {
      clarify_question: (d) => ({ ...d, upgraded_from: 32 }),
      loop_turn: (d) => ({ ...d, note: "migrated" }),
    },
  },
};

const ASK = { toolCalls: [{ name: "clarify", arguments: { questions: [{ question: "Which colour?", choices: ["red", "blue"] }] } }] };

eachLoopWorld("upgrade: a clarify wait survives a restart under new code with old rows", (use) => {
  it(
    "the answer completes under version 33 with rows written by version 32",
    use({ script: [ASK, { reply: "blue it is" }] }, async (w) => {
      await w.send("pick a colour");
      await w.until(() => w.replies.length === 1, "the question");
      const old = w.rows("clarify_question")[0]!;
      assert.equal(old.schema_version, 32);
      assert.equal(old.status, "open");
      assert.equal(w.rows("pending_call")[0]!.schema_version, 32);

      // The deploy: the old version stops, the new one starts on the same rows.
      w.b.crash("s1");
      w.code.migrations = V33;

      await w.send("blue");
      await w.until(() => w.replies.length === 2, "the final reply");
      assert.equal(w.replies[1]!.text, "blue it is");

      const q = w.rows("clarify_question")[0]!;
      assert.equal(q.status, "answered");
      assert.equal(q.schema_version, 33, "migrated on first read");
      assert.equal((JSON.parse(String(q.data)) as { upgraded_from: number }).upgraded_from, 32);
      const turn1 = w.rows("loop_turn", "turn_id = 'turn-1'")[0]!;
      assert.equal(turn1.schema_version, 32, "a row nobody reads again is not touched: migration is lazy, on first read");
      const turn2 = w.rows("loop_turn", "turn_id = 'turn-2'")[0]!;
      assert.equal(turn2.schema_version, 33, "new rows are written at the new version");
      assert.equal(w.rows("pending_call", "turn_id = 'turn-2'")[0]!.schema_version, 33);

      const answer = JSON.parse(String(w.rows("messages", "role = 'tool'")[0]!.content)) as { responses: Array<{ user_response: string }>; outcome: string };
      assert.equal(answer.responses[0]!.user_response, "blue");
      assert.equal(answer.outcome, "submitted");
      // The model saw the question, the answer and everything before it.
      const last = w.model.recorder.requests.at(-1)!.body as { messages: Array<{ role: string }> };
      assert.deepEqual(
        last.messages.map((m) => m.role),
        ["system", "user", "assistant", "tool"],
      );
      w.assertConsistent();
    }),
  );

  it(
    "the wait also survives restarts without a code change, and the question is not asked twice",
    use({ script: [ASK, { reply: "red it is" }] }, async (w) => {
      await w.send("pick a colour");
      await w.until(() => w.replies.length === 1, "the question");
      for (let i = 0; i < 3; i++) {
        w.b.crash("s1");
        await w.wakeAll();
        await w.b.settle();
      }
      assert.equal(w.replies.length, 1, "no new question after the restarts");
      assert.equal(w.rows("clarify_question").length, 1);
      assert.equal(w.rows("clarify_question")[0]!.status, "open");
      await w.send("red");
      await w.until(() => w.replies.length === 2, "the final reply");
      assert.equal(w.replies[1]!.text, "red it is");
    }),
  );
});
