import assert from "node:assert/strict";
import { it } from "node:test";
import { loadSurface, type ToolSchemasSurface } from "@hermesd/contracts";
import { compareGolden, goldenAdmissions, goldenMessages, GOLDEN_FORMAT, toolDefinitions, type GoldenRecord } from "@hermesd/session-actor";
import { eachLoopWorld } from "./test-util.ts";
import { scriptedTerminal, term, type LoopWorld } from "./world.ts";

// The port side of the golden transcripts (guide 7.2): every request that
// reached the model, in order, and the rows that the run wrote, as JSON.
// Also the compression threshold (guide 2.3) and the tool schemas as data.

const record = (w: LoopWorld, name: string): GoldenRecord =>
  w.model.recorder.toGolden(name, {
    messages: goldenMessages(w.rows("messages")),
    admissions: goldenAdmissions(w.rows("session_admissions")),
  });

const hookCalls: Array<{ estimatedTokens: number; threshold: number }> = [];

eachLoopWorld("golden transcript record and compression hook", (use) => {
  it(
    "records the requests in order, with the tools as data, and the rows",
    use(
      {
        script: [{ toolCalls: [term({ stdout: "hello from the shell" }, "call_a")] }, { reply: "finished" }],
        loop: scriptedTerminal,
      },
      async (w) => {
        await w.send("run it");
        await w.until(() => w.replies.length === 1, "the reply");
        const rec = record(w, "one-tool-call");
        // The record is plain JSON and survives a round trip.
        const again = JSON.parse(JSON.stringify(rec)) as GoldenRecord;
        assert.deepEqual(again, rec);
        assert.equal(rec.format, GOLDEN_FORMAT);
        assert.equal(rec.side, "port");
        assert.equal(rec.requests.length, 2);
        assert.deepEqual(compareGolden(rec, again), []);

        const first = rec.requests[0]!.body as { model: string; messages: Array<{ role: string; content: string }>; tools: unknown[] };
        assert.deepEqual(
          first.messages.map((m) => m.role),
          ["system", "user"],
        );
        assert.deepEqual(first.tools, toolDefinitions(), "the tools are the schemas as data");
        const second = rec.requests[1]!.body as { messages: Array<{ role: string; tool_call_id?: string }> };
        assert.deepEqual(
          second.messages.map((m) => m.role),
          ["system", "user", "assistant", "tool"],
        );
        assert.equal(second.messages[3]!.tool_call_id, "call_a");

        assert.deepEqual(
          rec.rows.messages.map((m) => m.role),
          ["user", "assistant", "tool", "assistant"],
        );
        assert.deepEqual(rec.rows.admissions, [{ status: "done", input: "run it", outcome: "finished" }]);

        // A difference is reported, and the call IDs and timestamps are not part of it.
        const changed: GoldenRecord = { ...again, rows: { ...again.rows, messages: again.rows.messages.slice(1) } };
        assert.deepEqual(compareGolden(rec, changed), ["messages rows differ"]);
      },
    ),
  );

  it(
    "emits the clarify schema from the contract files without change",
    use({ script: [{ reply: "ok" }] }, async (w) => {
      await w.send("hi");
      await w.until(() => w.replies.length === 1, "the reply");
      const sent = (w.model.recorder.requests[0]!.body as { tools: Array<{ function: { name: string } }> }).tools;
      const surface = loadSurface<ToolSchemasSurface>("tool-schemas");
      const upstream = surface.tools.find((t) => t.name === "clarify")!.schema;
      assert.deepEqual(sent.find((t) => t.function.name === "clarify")!.function, upstream);
      const todo = surface.tools.find((t) => t.name === "todo_list")!.schema;
      assert.deepEqual(sent.find((t) => t.function.name === "todo_list")!.function, todo);
    }),
  );

  it(
    "checks the 50% threshold before the call and calls the compression hook",
    use(
      {
        script: [{ reply: "short" }],
        loop: {
          contextWindow: 400,
          compress: async (info) => {
            hookCalls.push({ estimatedTokens: info.estimatedTokens, threshold: info.threshold });
          },
        },
      },
      async (w) => {
        hookCalls.length = 0;
        await w.send("x".repeat(400));
        await w.until(() => w.replies.length === 1, "the reply");
        assert.equal(hookCalls.length, 1, "the hook ran once, before the call");
        assert.equal(hookCalls[0]!.threshold, 200);
        assert.equal(hookCalls[0]!.estimatedTokens > 200, true);
        const data = JSON.parse(String(w.rows("pending_call")[0]!.data)) as { compression_due: boolean; estimated_tokens: number };
        assert.equal(data.compression_due, true, "the request is over half of the 400-token window");
      },
    ),
  );

  it(
    "does not flag compression for a small request",
    use({ script: [{ reply: "short" }] }, async (w) => {
      await w.send("hi");
      await w.until(() => w.replies.length === 1, "the reply");
      const data = JSON.parse(String(w.rows("pending_call")[0]!.data)) as { compression_due: boolean };
      assert.equal(data.compression_due, false);
    }),
  );
});
