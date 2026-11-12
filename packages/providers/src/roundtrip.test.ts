import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelClient } from "./client.ts";
import { ALL_MODES, MODELS, PARALLEL_CONVERSATION, TOOLS } from "./fixtures.ts";
import { ScriptedModel } from "./scripted.ts";
import type { ApiMode, Dict, Message, NormalizedResponse } from "./types.ts";

/** The assistant row that a loop would store for a response. */
function assistantRow(r: NormalizedResponse): Message {
  return {
    role: "assistant",
    content: r.content,
    ...(r.toolCalls.length > 0 ? { tool_calls: r.toolCalls } : {}),
    ...(r.providerData ?? {}),
  };
}

function bodyOf(mode: ApiMode, messages: Message[], stream = false): Dict {
  const c = createModelClient(mode, { model: MODELS[mode], stream, apiKey: "k" });
  return JSON.parse(c.buildBody({ messages, tools: TOOLS })) as Dict;
}

describe("request body per mode", () => {
  it("chat_completions keeps the table shape and the upstream key order", () => {
    const body = bodyOf("chat_completions", PARALLEL_CONVERSATION);
    assert.deepEqual(Object.keys(body), ["model", "messages", "tools"]);
    assert.deepEqual(body.messages.map((m: Dict) => m.role), ["system", "user", "assistant", "tool", "tool"]);
    assert.equal(body.messages[2].tool_calls.length, 2);
    assert.equal(body.messages[4].tool_call_id, "call_2");
    assert.equal(body.messages[4].content, "Error: cat: a.txt: Permission denied");
  });

  it("chat_completions asks for usage when it streams", () => {
    const body = bodyOf("chat_completions", PARALLEL_CONVERSATION, true);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  it("anthropic_messages moves the system prompt out and merges parallel results into one user turn", () => {
    const body = bodyOf("anthropic_messages", PARALLEL_CONVERSATION);
    assert.deepEqual(Object.keys(body), ["model", "messages", "max_tokens", "system", "tools", "tool_choice"]);
    // A Claude model on the Messages wire caches: the system prompt is one marked block (prompt-caching.ts).
    assert.deepEqual(body.system, [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }]);
    assert.deepEqual(body.messages.map((m: Dict) => m.role), ["user", "assistant", "user"]);
    const results = body.messages[2].content;
    assert.deepEqual(results.map((b: Dict) => [b.type, b.tool_use_id]), [["tool_result", "call_1"], ["tool_result", "call_2"]]);
    assert.equal(body.tools[0].input_schema.type, "object");
  });

  it("codex_responses puts the system prompt in instructions and sends calls and outputs as items", () => {
    const body = bodyOf("codex_responses", PARALLEL_CONVERSATION);
    assert.deepEqual(Object.keys(body).slice(0, 5), ["model", "instructions", "input", "store", "tools"]);
    assert.equal(body.instructions, "You are helpful.");
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, true);
    assert.deepEqual(body.input.map((i: Dict) => i.type), ["message", "function_call", "function_call", "function_call_output", "function_call_output"]);
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  });

  it("bedrock_converse has no model in the body and puts the system prompt in `system`", () => {
    const body = bodyOf("bedrock_converse", PARALLEL_CONVERSATION);
    assert.equal("modelId" in body, false);
    assert.deepEqual(body.system[0], { text: "You are helpful." });
    assert.deepEqual(body.messages.map((m: Dict) => m.role), ["user", "assistant", "user"]);
    assert.deepEqual(body.messages[2].content.map((b: Dict) => b.toolResult.toolUseId), ["call_1", "call_2"]);
    assert.equal(body.toolConfig.tools[0].toolSpec.name, "shell");
  });
});

for (const mode of ALL_MODES) {
  for (const stream of [false, true]) {
    describe(`${mode} ${stream ? "streamed" : "plain"} round trip`, () => {
      const client = createModelClient(mode, { model: MODELS[mode], stream, apiKey: "k" });

      it("returns text and parallel tool calls in the normalized shape", async () => {
        const model = new ScriptedModel(mode, [{ reply: "Working on it", toolCalls: [{ name: "shell", arguments: { command: "pwd" } }, { name: "shell", arguments: { command: "date" } }] }], { stream });
        const { response } = await client.send(client.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c1", fetch: model.fetch });
        assert.equal(response.content, "Working on it");
        assert.equal(response.finishReason, "tool_calls");
        assert.deepEqual(response.toolCalls.map((c) => [c.function.name, c.function.arguments]), [["shell", '{"command":"pwd"}'], ["shell", '{"command":"date"}']]);
        assert.notEqual(response.toolCalls[0]!.id, response.toolCalls[1]!.id);
        assert.deepEqual(response.usage, { promptTokens: 10, completionTokens: 5, cachedTokens: 0 });
      });

      it("returns a plain answer with the stop finish reason", async () => {
        const model = new ScriptedModel(mode, [{ reply: "All done." }], { stream });
        const { response } = await client.send(client.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c1", fetch: model.fetch });
        assert.equal(response.content, "All done.");
        assert.deepEqual(response.toolCalls, []);
        assert.equal(response.finishReason, "stop");
      });

      it("replays the stored assistant row, with its tool results, in the next request", async () => {
        const model = new ScriptedModel(mode, [{ toolCalls: [{ name: "shell", arguments: { command: "pwd" } }, { name: "shell", arguments: { command: "date" } }] }, { reply: "ok" }], { stream });
        const first = await client.send(client.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c1", fetch: model.fetch });
        const row = assistantRow(first.response);
        const next: Message[] = [
          ...PARALLEL_CONVERSATION,
          row,
          { role: "tool", tool_call_id: first.response.toolCalls[0]!.id, content: "/work" },
          { role: "tool", tool_call_id: first.response.toolCalls[1]!.id, content: "Error: date: command not found" },
        ];
        const second = await client.send(client.buildBody({ messages: next, tools: TOOLS }), { callId: "c2", fetch: model.fetch });
        assert.equal(second.response.content, "ok");
        const sent = JSON.stringify(model.requests[1]!.body);
        for (const c of first.response.toolCalls) assert.ok(sent.includes(c.id), `the second request names ${c.id}`);
        assert.ok(sent.includes("command not found"), "the tool error text is in the second request");
      });
    });
  }

  describe(`${mode} stream equals plain`, () => {
    it("gives the same normalized answer for a streamed and a plain body", async () => {
      const steps = [{ reply: "Let me check", toolCalls: [{ name: "shell", arguments: { command: "ls -la" } }, { name: "shell", arguments: { command: "pwd" } }], chunks: 3 }];
      const out: NormalizedResponse[] = [];
      for (const stream of [false, true]) {
        const c = createModelClient(mode, { model: MODELS[mode], stream, apiKey: "k" });
        const m = new ScriptedModel(mode, steps, { stream });
        out.push((await c.send(c.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "same", fetch: m.fetch })).response);
      }
      assert.deepEqual(out[1], out[0]);
    });
  });
}

describe("headers and URLs", () => {
  it("sends the call id as the idempotency key and the key in the mode's header", async () => {
    const want: Record<ApiMode, [string, RegExp]> = {
      chat_completions: ["authorization", /^Bearer k$/],
      anthropic_messages: ["x-api-key", /^k$/],
      codex_responses: ["authorization", /^Bearer k$/],
      bedrock_converse: ["authorization", /^Bearer k$/],
    };
    for (const mode of ALL_MODES) {
      const c = createModelClient(mode, { model: MODELS[mode], apiKey: "k" });
      const m = new ScriptedModel(mode, [{ reply: "x" }]);
      await c.send(c.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "call-9", fetch: m.fetch });
      const h = m.requests[0]!.headers;
      assert.equal(h["idempotency-key"], "call-9");
      const [name, re] = want[mode];
      assert.match(h[name] ?? "", re, mode);
    }
  });

  it("puts the Bedrock model id in the path", async () => {
    const c = createModelClient("bedrock_converse", { model: MODELS.bedrock_converse, region: "eu-west-1" });
    const m = new ScriptedModel("bedrock_converse", [{ reply: "x" }]);
    await c.send(c.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c", fetch: m.fetch });
    assert.equal(m.requests[0]!.path, `/model/${encodeURIComponent(MODELS.bedrock_converse)}/converse`);
  });

  it("uses an injected signer for Bedrock", async () => {
    const c = createModelClient("bedrock_converse", {
      model: MODELS.bedrock_converse,
      signer: { sign: async (r) => ({ authorization: `AWS4-HMAC-SHA256 region=${r.region}`, "x-amz-date": "20260101T000000Z" }) },
    });
    const m = new ScriptedModel("bedrock_converse", [{ reply: "x" }]);
    await c.send(c.buildBody({ messages: PARALLEL_CONVERSATION, tools: TOOLS }), { callId: "c", fetch: m.fetch });
    assert.equal(m.requests[0]!.headers.authorization, "AWS4-HMAC-SHA256 region=us-east-1");
  });
});
