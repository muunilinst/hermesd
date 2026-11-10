import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelClient } from "./client.ts";
import { ALL_MODES, MODELS, PARALLEL_CONVERSATION, TOOLS } from "./fixtures.ts";
import { ScriptedModel } from "./scripted.ts";
import { StreamDroppedError } from "./sse.ts";
import type { ApiMode } from "./types.ts";

const STEP = { reply: "Let me look at the directory now", toolCalls: [{ name: "shell", arguments: { command: "ls -la /work" } }], chunks: 4 };

/** The number of frames to keep so that the cut falls in the middle of the text. */
const MID_TEXT: Record<ApiMode, number> = { chat_completions: 3, anthropic_messages: 4, codex_responses: 2, bedrock_converse: 3 };

describe("a stream that drops mid-token", () => {
  for (const mode of ALL_MODES) {
    for (const dropMode of ["close", "error"] as const) {
      it(`${mode}: a ${dropMode === "close" ? "closed" : "broken"} stream is a StreamDroppedError, and a re-send gets the whole answer`, async () => {
        const model = new ScriptedModel(mode, [{ ...STEP, dropAfter: MID_TEXT[mode], dropMode }], { stream: true });
        const client = createModelClient(mode, { model: MODELS[mode], stream: true, apiKey: "k" });
        const body = client.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS });
        await assert.rejects(client.send(body, { callId: "c1", fetch: model.fetch }), (e: unknown) => e instanceof StreamDroppedError);
        // The loop sends the stored bytes again with the same call id.
        const again = await client.send(body, { callId: "c1", fetch: model.fetch });
        assert.equal(again.response.content, STEP.reply, "no partial text from the first try");
        assert.equal(again.response.toolCalls.length, 1);
        assert.equal(again.response.toolCalls[0]!.function.arguments, '{"command":"ls -la /work"}');
        assert.equal(model.requests.length, 2);
        assert.deepEqual(model.requests[1]!.body, model.requests[0]!.body, "the same bytes");
        assert.equal(model.requests[1]!.callId, "c1");
      });
    }
  }

  it("uses the upstream text for a stream that ends before its terminal event", async () => {
    const texts: Record<ApiMode, RegExp> = {
      chat_completions: /ended before the final chunk/,
      anthropic_messages: /^Anthropic Messages stream ended before message_stop \(possible upstream stream drop\)\.$/,
      codex_responses: /ended before response\.completed/,
      bedrock_converse: /^Bedrock Converse stream ended before messageStop; response is incomplete$/,
    };
    for (const mode of ALL_MODES) {
      const model = new ScriptedModel(mode, [{ ...STEP, dropAfter: 2 }], { stream: true });
      const client = createModelClient(mode, { model: MODELS[mode], stream: true });
      await assert.rejects(client.send(client.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c", fetch: model.fetch }), (e: Error) => {
        assert.equal(e.name, "StreamDroppedError");
        assert.match(e.message, texts[mode], mode);
        return true;
      });
    }
  });

  it("does not turn an abort into a drop", async () => {
    const model = new ScriptedModel("chat_completions", [{ hold: "h" }], { stream: true });
    const client = createModelClient("chat_completions", { model: "gpt-4o", stream: true });
    const ac = new AbortController();
    const pending = client.send(client.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c", fetch: model.fetch, signal: ac.signal });
    ac.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(model.aborted, 1);
  });
});

describe("streaming deltas into a final message", () => {
  it("merges chat tool-call fragments by index and keeps the last usage", async () => {
    const model = new ScriptedModel(
      "chat_completions",
      [{ toolCalls: [{ name: "a", arguments: { x: 1, y: "two" } }, { name: "b", arguments: { z: [1, 2, 3] } }], chunks: 5, usage: { prompt_tokens: 42, completion_tokens: 7 } }],
      { stream: true },
    );
    const client = createModelClient("chat_completions", { model: "gpt-4o", stream: true });
    const { response } = await client.send(client.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c", fetch: model.fetch });
    assert.deepEqual(response.toolCalls.map((c) => [c.function.name, JSON.parse(c.function.arguments)]), [["a", { x: 1, y: "two" }], ["b", { z: [1, 2, 3] }]]);
    assert.deepEqual(response.usage, { promptTokens: 42, completionTokens: 7, cachedTokens: 0 });
  });

  it("rebuilds Anthropic tool input from partial JSON", async () => {
    const model = new ScriptedModel("anthropic_messages", [{ toolCalls: [{ name: "a", arguments: { path: "/a/b/c", n: 12345 } }], chunks: 6 }], { stream: true });
    const client = createModelClient("anthropic_messages", { model: "claude-sonnet-4-5", stream: true });
    const { response } = await client.send(client.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c", fetch: model.fetch });
    assert.deepEqual(JSON.parse(response.toolCalls[0]!.function.arguments), { path: "/a/b/c", n: 12345 });
  });

  it("decodes Bedrock event-stream frames with a checksum", async () => {
    const model = new ScriptedModel("bedrock_converse", [{ reply: "hello there", toolCalls: [{ name: "a", arguments: { k: "v" } }], chunks: 3 }], { stream: true });
    const client = createModelClient("bedrock_converse", { model: MODELS.bedrock_converse, stream: true });
    const { response } = await client.send(client.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c", fetch: model.fetch });
    assert.equal(response.content, "hello there");
    assert.equal(response.toolCalls[0]!.function.arguments, '{"k":"v"}');
  });
});
