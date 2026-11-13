import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAnthropicBody } from "./anthropic.ts";
import { buildChatBody } from "./chat.ts";
import { TOOLS } from "./fixtures.ts";
import { anthropicPromptCachePolicy, applyAnthropicCacheControl, isOneShotRequest, planPromptCache } from "./prompt-caching.ts";
import type { Dict, Message } from "./types.ts";

const EPH = { type: "ephemeral" };
const SYSTEM = "You are a helpful agent.\n\nConversation started today.";
const STATIC = "You are a helpful agent.";

const CONVO: Message[] = [
  { role: "system", content: SYSTEM },
  { role: "user", content: "say hello" },
  { role: "assistant", content: "I will run it.", tool_calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: '{"command":"echo hello"}' } }] },
  { role: "tool", tool_call_id: "call_1", content: '{"output":"hello"}' },
];

const marked = (m: Message): boolean =>
  "cache_control" in m || (Array.isArray(m.content) && m.content.some((p) => (p as Dict).cache_control !== undefined));

describe("prompt caching: breakpoint layout (apply_anthropic_cache_control)", () => {
  it("with a static prefix: two system markers and the last two messages", () => {
    const out = applyAnthropicCacheControl(CONVO, { native: true, staticSystemPrefix: STATIC });
    assert.deepEqual(out[0]!.content, [
      { type: "text", text: STATIC, cache_control: EPH },
      { type: "text", text: SYSTEM.slice(STATIC.length), cache_control: EPH },
    ]);
    assert.deepEqual(out.slice(1).map(marked), [false, true, true]);
    assert.deepEqual(out[2]!.content, [{ type: "text", text: "I will run it.", cache_control: EPH }]);
    assert.deepEqual(out[3]!.cache_control, EPH, "a native tool message gets a top-level marker; the converter moves it");
  });

  it("without a static prefix: the system prompt and the last three messages", () => {
    const out = applyAnthropicCacheControl(CONVO, { native: true });
    assert.deepEqual(out[0]!.content, [{ type: "text", text: SYSTEM, cache_control: EPH }]);
    assert.deepEqual(out.slice(1).map(marked), [true, true, true]);
  });

  it("a prefix the prompt does not start with falls back to one system marker", () => {
    const out = applyAnthropicCacheControl(CONVO, { native: true, staticSystemPrefix: "Something else" });
    assert.deepEqual(out[0]!.content, [{ type: "text", text: SYSTEM, cache_control: EPH }]);
  });

  it("never more than four markers, and the input is not changed", () => {
    const long: Message[] = [CONVO[0]!, ...Array.from({ length: 6 }, (_, i): Message => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }))];
    const before = JSON.stringify(long);
    const out = applyAnthropicCacheControl(long, { native: true, staticSystemPrefix: STATIC });
    assert.equal(out.slice(1).filter(marked).length, 2);
    assert.deepEqual(out.slice(1).map(marked), [false, false, false, false, true, true]);
    assert.equal(JSON.stringify(long), before);
  });

  it("the 1h TTL goes on every marker", () => {
    const out = applyAnthropicCacheControl(CONVO, { native: true, ttl: "1h" });
    assert.deepEqual(out[3]!.cache_control, { type: "ephemeral", ttl: "1h" });
  });

  it("the envelope layout skips empty assistant content and puts tool markers in parts", () => {
    const msgs: Message[] = [CONVO[0]!, CONVO[1]!, { ...CONVO[2]!, content: "" }, CONVO[3]!];
    const out = applyAnthropicCacheControl(msgs, { native: false });
    assert.equal(marked(out[2]!), false, "an empty assistant turn cannot carry a marker on the envelope");
    assert.deepEqual(out[3]!.content, [{ type: "text", text: '{"output":"hello"}', cache_control: EPH }]);
    assert.equal("cache_control" in out[3]!, false);
  });
});

describe("prompt caching: which routes cache (anthropic_prompt_cache_policy)", () => {
  const cases: Array<[string, Parameters<typeof anthropicPromptCachePolicy>[0], [boolean, boolean]]> = [
    ["native Anthropic", { mode: "anthropic_messages", model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com/v1/messages" }, [true, true]],
    ["a third-party gateway with a Claude model", { mode: "anthropic_messages", model: "claude-sonnet-4-5", baseUrl: "http://127.0.0.1:9/v1/messages" }, [true, true]],
    ["a non-Claude model on a third-party Messages gateway", { mode: "anthropic_messages", model: "glm-4.6", baseUrl: "https://example.com/anthropic" }, [false, false]],
    ["MiniMax M3", { mode: "anthropic_messages", model: "MiniMax-M3", baseUrl: "https://api.minimax.io/anthropic" }, [false, false]],
    ["MiniMax M2", { mode: "anthropic_messages", model: "MiniMax-M2.5", baseUrl: "https://api.minimax.io/anthropic" }, [true, true]],
    ["OpenRouter Claude on the OpenAI wire", { mode: "chat_completions", model: "anthropic/claude-sonnet-4.5", baseUrl: "https://openrouter.ai/api/v1/chat/completions" }, [true, false]],
    ["OpenAI", { mode: "chat_completions", model: "gpt-4o", baseUrl: "https://api.openai.com/v1/chat/completions" }, [false, false]],
    ["Bedrock (its own cachePoint markers)", { mode: "bedrock_converse", model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }, [false, false]],
  ];
  for (const [name, route, want] of cases) it(name, () => assert.deepEqual(anthropicPromptCachePolicy(route), want));
});

describe("prompt caching: on the wire", () => {
  it("a one-shot request (a compaction summary) gets no marker", () => {
    const one: Message[] = [{ role: "user", content: "summarize" }];
    assert.equal(isOneShotRequest(one, []), true);
    assert.equal(isOneShotRequest(one, TOOLS), false);
    assert.deepEqual(planPromptCache(one, [], { mode: "anthropic_messages", model: "claude-sonnet-4-5" }).messages, one);
  });

  it("anthropic_messages: system blocks, a marked text block and a marked tool_result", () => {
    const body = JSON.parse(
      buildAnthropicBody({ model: "claude-sonnet-4-5", messages: CONVO, tools: TOOLS, options: { baseUrl: "https://api.anthropic.com/v1/messages", staticSystemPrefix: STATIC } }),
    ) as Dict;
    assert.equal(body.system.length, 2);
    assert.ok(body.system.every((b: Dict) => b.cache_control));
    assert.equal(body.messages[0].content, "say hello", "the oldest message is past the window");
    assert.deepEqual(body.messages[1].content[0], { type: "text", text: "I will run it.", cache_control: EPH });
    assert.equal(body.messages[1].content[1].cache_control, undefined, "the tool_use block is not marked");
    assert.deepEqual(body.messages[2].content[0].cache_control, EPH, "the tool_result block carries the marker");
    assert.equal(body.tools.some((t: Dict) => t.cache_control), false);
  });

  it("caching can be turned off", () => {
    const body = JSON.parse(buildAnthropicBody({ model: "claude-sonnet-4-5", messages: CONVO, tools: TOOLS, options: { promptCaching: false } })) as Dict;
    assert.equal(body.system, SYSTEM);
    assert.equal(JSON.stringify(body).includes("cache_control"), false);
  });

  it("chat_completions to OpenAI stays unmarked", () => {
    const body = buildChatBody({ model: "gpt-4o", messages: CONVO, tools: TOOLS, options: { baseUrl: "https://api.openai.com/v1/chat/completions" } });
    assert.equal(body.includes("cache_control"), false);
  });
});

describe("prompt caching: markers that came with the request", () => {
  const countMarkers = (body: Dict): number => (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;

  it("a marked tool and marked messages never push the request past four breakpoints", () => {
    const tools = [{ ...TOOLS[0]!, cache_control: EPH }, ...TOOLS.slice(1)];
    const msgs: Message[] = [
      { role: "system", content: [{ type: "text", text: STATIC, cache_control: EPH }, { type: "text", text: SYSTEM.slice(STATIC.length), cache_control: EPH }] },
      { role: "user", content: [{ type: "text", text: "say hello", cache_control: EPH }] },
      ...CONVO.slice(2),
    ];
    const body = JSON.parse(
      buildAnthropicBody({ model: "claude-sonnet-4-5", messages: msgs, tools, options: { baseUrl: "https://api.anthropic.com/v1/messages", staticSystemPrefix: STATIC } }),
    ) as Dict;
    assert.equal(countMarkers(body), 4);
    assert.equal(body.tools.some((t: Dict) => t.cache_control), false, "the planner owns the breakpoints: the tool marker is dropped");
    assert.equal(body.messages[0].content, "say hello", "the old marker on the first user message is gone, and its one-part shape with it");
  });

  it("planning twice gives the same request", () => {
    const once = applyAnthropicCacheControl(CONVO, { native: true, staticSystemPrefix: STATIC });
    assert.deepEqual(applyAnthropicCacheControl(once, { native: true, staticSystemPrefix: STATIC }), once);
  });

  it("with caching off, markers that came in are left alone", () => {
    const tools = [{ ...TOOLS[0]!, cache_control: EPH }];
    const r = planPromptCache(CONVO, tools, { mode: "anthropic_messages", model: "claude-sonnet-4-5", promptCaching: false });
    assert.deepEqual(r.tools, tools);
  });
});

describe("prompt caching: the final request stays within four breakpoints", () => {
  const countMarkers = (body: Dict): number => (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;
  const NATIVE = { baseUrl: "https://api.anthropic.com/v1/messages", staticSystemPrefix: STATIC };
  const SIGNED: Message = {
    role: "assistant",
    content: "I will run it.",
    tool_calls: CONVO[2]!.tool_calls!,
    anthropic_content_blocks: [
      { type: "thinking", thinking: "Plan.", signature: "SIG==" },
      { type: "text", text: "I will run it.", cache_control: EPH },
      { type: "tool_use", id: "call_1", name: "terminal", input: { command: "echo hello" } },
    ],
  };

  it("a marker inside replayed ordered blocks is dropped before the planner places its four", () => {
    // The signed turn is old: two newer messages follow it, so it is outside the planner's window.
    const msgs: Message[] = [CONVO[0]!, CONVO[1]!, SIGNED, CONVO[3]!, { role: "user", content: "next" }, { role: "assistant", content: "ok" }, { role: "user", content: "and now" }];
    const body = JSON.parse(buildAnthropicBody({ model: "claude-sonnet-4-5", messages: msgs, tools: TOOLS, options: NATIVE })) as Dict;
    assert.equal(countMarkers(body), 4);
    assert.equal(JSON.stringify(body.messages[1]).includes("cache_control"), false, "the old replayed turn carries no marker");
  });

  it("a marked tool passed through extraBody is capped, and the caller's object is not changed", () => {
    const extraTools = [{ name: "terminal", description: "run", input_schema: { type: "object" }, cache_control: EPH }];
    const extraBody = { tools: extraTools };
    const body = JSON.parse(buildAnthropicBody({ model: "claude-sonnet-4-5", messages: CONVO, tools: TOOLS, options: { ...NATIVE, extraBody } })) as Dict;
    assert.equal(countMarkers(body), 4);
    assert.equal(body.tools[0].cache_control, undefined, "the override's tool marker goes first");
    assert.deepEqual(body.system.map((b: Dict) => Boolean(b.cache_control)), [true, true], "the planner's system breakpoints stay");
    assert.deepEqual(extraTools[0]!.cache_control, EPH);
  });

  it("the same guard holds on the OpenAI-wire envelope route", () => {
    const extraBody = { tools: [{ ...TOOLS[0]!, cache_control: EPH }] };
    const body = JSON.parse(
      buildChatBody({ model: "anthropic/claude-sonnet-4.5", messages: CONVO, tools: TOOLS, options: { baseUrl: "https://openrouter.ai/api/v1/chat/completions", extraBody } }),
    ) as Dict;
    assert.ok(countMarkers(body) <= 4);
  });

  it("caching off: an override's markers are the caller's business", () => {
    const extraBody = { tools: [{ name: "t", input_schema: { type: "object" }, cache_control: EPH }] };
    const body = JSON.parse(buildAnthropicBody({ model: "claude-sonnet-4-5", messages: CONVO, tools: TOOLS, options: { promptCaching: false, extraBody } })) as Dict;
    assert.deepEqual(body.tools[0].cache_control, EPH);
  });
});

describe("prompt caching: what the limiter must not touch", () => {
  const countMarkers = (body: Dict): number => (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;
  // A real tool can take a parameter named cache_control: that is schema, not a breakpoint.
  const schemaTool = () => ({
    type: "function",
    function: {
      name: "set_cache",
      description: "Set a cache policy.",
      parameters: { type: "object", properties: { cache_control: { type: "object", properties: { type: { type: "string" } } } }, required: ["cache_control"] },
    },
  });

  it("native Anthropic: a parameter named cache_control keeps its schema", () => {
    const tool = schemaTool();
    const before = JSON.stringify(tool);
    const body = JSON.parse(
      buildAnthropicBody({ model: "claude-sonnet-4-5", messages: CONVO, tools: [tool], options: { baseUrl: "https://api.anthropic.com/v1/messages", staticSystemPrefix: STATIC } }),
    ) as Dict;
    assert.deepEqual(body.tools[0].input_schema.properties.cache_control, { type: "object", properties: { type: { type: "string" } } });
    assert.deepEqual(body.tools[0].input_schema.required, ["cache_control"]);
    assert.equal(JSON.stringify(tool), before, "the caller's tool is not changed");
  });

  it("OpenRouter: a parameter named cache_control keeps its schema, and the caller's tool is not changed", () => {
    const tool = schemaTool();
    const before = JSON.stringify(tool);
    const body = JSON.parse(
      buildChatBody({ model: "anthropic/claude-sonnet-4.5", messages: CONVO, tools: [tool], options: { baseUrl: "https://openrouter.ai/api/v1/chat/completions" } }),
    ) as Dict;
    assert.deepEqual(body.tools[0].function.parameters.properties.cache_control, { type: "object", properties: { type: { type: "string" } } });
    assert.equal(JSON.stringify(tool), before);
  });

  it("a caller's automatic cache marker is honored: no explicit markers are added", () => {
    const auto = { type: "ephemeral", ttl: "1h" };
    const body = JSON.parse(
      buildAnthropicBody({ model: "claude-sonnet-4-5", messages: CONVO, tools: TOOLS, options: { baseUrl: "https://api.anthropic.com/v1/messages", extraBody: { cache_control: auto } } }),
    ) as Dict;
    assert.deepEqual(body.cache_control, auto);
    assert.equal(countMarkers(body), 1, "only the caller's marker");
    assert.equal(body.system, SYSTEM);
  });

  it("the same on the OpenRouter route", () => {
    const body = JSON.parse(
      buildChatBody({ model: "anthropic/claude-sonnet-4.5", messages: CONVO, tools: TOOLS, options: { baseUrl: "https://openrouter.ai/api/v1/chat/completions", extraBody: { cache_control: { type: "ephemeral" } } } }),
    ) as Dict;
    assert.equal(countMarkers(body), 1);
  });
});
