import assert from "node:assert/strict";
import { it } from "node:test";
import { ALL_MODES, MODELS, ScriptedModel, createModelClient, type ApiMode, type ScriptStep } from "@hermesd/providers";
import { eachLoopWorld } from "./test-util.ts";
import type { LoopWorldOptions } from "./world.ts";

// The provider seam in the loop (guide 2.7, 6.3, 7.2). The same golden script runs in
// every API mode, plain and streamed. A stream that drops in the middle of a token
// drops its partial output, and the loop sends the stored request again (porting rule 1).

const GOLDEN: ScriptStep[] = [
  { reply: "I will build it", toolCalls: [{ name: "terminal", arguments: { command: JSON.stringify({ stdout: "built" }) } }] },
  { reply: "it is built" },
];

function provider(mode: ApiMode, script: ScriptStep[], stream: boolean): NonNullable<LoopWorldOptions["provider"]> {
  const model = new ScriptedModel(mode, script, { stream });
  return { client: createModelClient(mode, { model: MODELS[mode], stream }), model };
}

const opts = (mode: ApiMode, script: ScriptStep[], stream: boolean): LoopWorldOptions => ({
  script: [],
  provider: provider(mode, script, stream),
  loop: { buildCommand: (a) => ({ argv: ["scripted", a.command] }), model: MODELS[mode] },
});

eachLoopWorld("provider seam: golden script in every mode", (use) => {
  for (const mode of ALL_MODES) {
    for (const stream of [false, true]) {
      it(
        `${mode} ${stream ? "streamed" : "plain"}: a terminal call, then the reply`,
        use(() => opts(mode, GOLDEN, stream), async (w) => {
          await w.send("build it");
          await w.until(() => w.replies.length === 1, "the reply");
          assert.equal(w.replies[0]!.text, "it is built");
          const msgs = w.rows("messages");
          assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
          assert.equal(msgs[1]!.content, "I will build it");
          assert.match(String(w.rows("messages", "role = 'tool'")[0]!.content), /built/);
          assert.equal(w.provider!.requests.length, 2);
          // Each request is in the wire format of the mode.
          const first = w.provider!.requests[0]!;
          assert.match(first.path, mode === "chat_completions" ? /chat\/completions$/ : mode === "anthropic_messages" ? /messages$/ : mode === "codex_responses" ? /responses$/ : /converse(-stream)?$/);
          w.assertConsistent();
        }),
      );
    }
  }
});

eachLoopWorld("provider seam: a stream that drops mid-token", (use) => {
  for (const mode of ALL_MODES) {
    it(
      `${mode}: the partial output is dropped and the stored request is sent again`,
      use(
        () => opts(mode, [{ reply: "I will start the build now", chunks: 4, dropAfter: 3, dropMode: "error" }], true),
        async (w) => {
          await w.send("build it");
          // The first try ends in a dropped stream. The obligation brings the wake that sends it again.
          await w.until(() => w.provider!.requests.length >= 1, "the first request");
          await w.b.settle();
          await w.wakeAll();
          await w.until(() => w.replies.length === 1, "the reply");
          assert.equal(w.replies[0]!.text, "I will start the build now", "the whole answer, not the partial text twice");
          const reqs = w.provider!.requests;
          assert.equal(reqs.length, 2, "the request went out twice");
          assert.equal(reqs[0]!.callId, reqs[1]!.callId, "with the same call id");
          assert.deepEqual(reqs[0]!.body, reqs[1]!.body, "and the same bytes");
          const assistant = w.rows("messages", "role = 'assistant'");
          assert.equal(assistant.length, 1, "no partial assistant row");
          assert.equal(assistant[0]!.content, "I will start the build now");
          assert.equal(w.rows("pending_call").length, 1);
          assert.equal(w.rows("pending_call")[0]!.status, "done");
          w.assertConsistent();
        },
      ),
    );
  }

  it(
    "a closed stream with no terminal event is dropped too",
    use(() => opts("anthropic_messages", [{ reply: "whole answer", dropAfter: 4 }], true), async (w) => {
      await w.send("hi");
      await w.until(() => w.provider!.requests.length >= 1, "the first request");
      await w.b.settle();
      await w.wakeAll();
      await w.until(() => w.replies.length === 1, "the reply");
      assert.equal(w.replies[0]!.text, "whole answer");
      assert.equal(w.rows("messages", "role = 'assistant'").length, 1);
      w.assertConsistent();
    }),
  );
});

eachLoopWorld("provider seam: 429 in every mode", (use) => {
  for (const mode of ALL_MODES) {
    it(
      `${mode}: a 429 is waited out and the same request is sent again`,
      use(() => opts(mode, [{ status: 429, times: 1, reply: "after the limit" }], false), async (w) => {
        await w.send("hi");
        await w.until(() => w.provider!.requests.length >= 1, "the first request");
        await w.b.settle();
        await w.wakeAll();
        await w.until(() => w.replies.length === 1, "the reply");
        assert.equal(w.replies[0]!.text, "after the limit");
        assert.equal(w.provider!.requests.length, 2);
        assert.equal(w.provider!.requests[0]!.callId, w.provider!.requests[1]!.callId);
        w.assertConsistent();
      }),
    );
  }

  it(
    "a 400 ends the turn with the status",
    use(() => opts("chat_completions", [{ status: 400 }], false), async (w) => {
      await w.send("hi");
      await w.until(() => w.replies.length === 1, "the error reply");
      assert.match(w.replies[0]!.text, /the model returned HTTP 400/);
      assert.equal(w.rows("pending_call")[0]!.status, "failed");
      w.assertConsistent();
    }),
  );
});
