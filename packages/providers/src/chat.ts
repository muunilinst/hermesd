import { StreamDroppedError, guardedEvents } from "./sse.ts";
import { planPromptCache } from "./prompt-caching.ts";
import { type Dict, type Message, type ModelCallInput, type NormalizedResponse, type ToolCallWire, type Usage, isDict } from "./types.ts";

/**
 * The OpenAI chat_completions mode.
 *
 * Upstream: `agent/transports/chat_completions.py` (`ChatCompletionsTransport`:
 * `convert_messages`, `build_kwargs`, `normalize_response`) and the stream
 * assembly in `agent/auxiliary_client.py:_ChatStreamAccumulator`.
 *
 * Only the generic path is ported: a provider with no `ProviderProfile`
 * (upstream "legacy flag path"). Provider profiles are a later step.
 */

/** Keys that are stored with a message but that strict providers reject. `chat_completions.py:_STRIP_MSG_KEYS`. */
const STRIP_MSG_KEYS = new Set([
  "codex_reasoning_items",
  "codex_message_items",
  "tool_name",
  "effect_disposition",
  "timestamp",
  "platform_message_id",
  "message_id",
  "api_content",
  "anthropic_content_blocks",
  "bedrock_content_blocks",
  "message_uid",
  "data_use",
]);
/** Keys of a tool call that are stripped. `chat_completions.py:_STRIP_TC_KEYS`. */
const STRIP_TC_KEYS = ["call_id", "response_item_id"];

/** `agent/prompt_builder.py:DEVELOPER_ROLE_MODELS`. */
const DEVELOPER_ROLE_MODELS = ["gpt-5", "codex"];

/**
 * The reasoning keys an assistant message may carry on a route.
 * `agent/message_sanitization.py:route_reasoning_carriers`, reduced to the
 * default (`reasoning_content` only), the strict hosts (none) and the
 * OpenRouter-format hosts (`reasoning_details` too).
 */
export function reasoningCarriers(baseUrl: string | null | undefined): Set<string> {
  const host = hostOf(baseUrl);
  if (["mistral.ai", "groq.com", "cerebras.ai", "sambanova.ai"].some((h) => hostMatches(host, h))) return new Set();
  if (hostMatches(host, "openrouter.ai")) return new Set(["reasoning_content", "reasoning_details"]);
  return new Set(["reasoning_content"]);
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Sanitized copy of a message, or the same object when nothing needs stripping. `chat_completions.py:_sanitize_message`. */
export function sanitizeMessage(msg: Message, carriers: Set<string>, keepExtraContent = false): Message {
  const out: Dict = {};
  let changed = false;
  for (const [k, v] of Object.entries(msg)) {
    const reasoningKey = k === "reasoning_content" || k === "reasoning" || k === "reasoning_details";
    if (STRIP_MSG_KEYS.has(k) || k.startsWith("_") || (msg.role === "assistant" && reasoningKey && !carriers.has(k))) {
      changed = true;
      continue;
    }
    if (msg.role === "tool" && k === "name") {
      changed = true;
      continue;
    }
    if (k === "tool_calls" && msg.role === "assistant" && (v === null || (Array.isArray(v) && v.length === 0))) {
      changed = true;
      continue;
    }
    if (k === "tool_calls" && Array.isArray(v)) {
      out[k] = v.map((tc) => {
        if (!isDict(tc)) return tc;
        const keys = STRIP_TC_KEYS.filter((s) => s in tc);
        if ("extra_content" in tc && !keepExtraContent) keys.push("extra_content"); // only Gemini routes keep it
        if (keys.length === 0) return tc;
        changed = true;
        return Object.fromEntries(Object.entries(tc).filter(([ck]) => !keys.includes(ck)));
      });
      continue;
    }
    out[k] = v;
  }
  return changed ? (out as Message) : msg;
}

/** `convert_messages`: strip what strict providers reject. */
export function convertMessagesChat(messages: Message[], baseUrl?: string | null, model = ""): Message[] {
  const carriers = reasoningCarriers(baseUrl);
  // Gemini routes need the thought signature in `extra_content` (`_model_consumes_thought_signature`).
  const gemini = /gemini|gemma/i.test(model) || hostMatches(hostOf(baseUrl), "googleapis.com");
  return messages.map((m) => sanitizeMessage(m, carriers, gemini));
}

/** GPT-5 and Codex models take a `developer` role instead of `system`. `chat_completions.py:_swap_developer_role`. */
export function swapDeveloperRole(messages: Message[], model: string): Message[] {
  const lower = model.toLowerCase();
  const first = messages[0];
  if (first && first.role === "system" && DEVELOPER_ROLE_MODELS.some((p) => lower.includes(p))) {
    return [{ ...first, role: "developer" }, ...messages.slice(1)];
  }
  return messages;
}

/**
 * The request body. Key order follows `build_kwargs`: model, messages, tools,
 * the output limit, `extra_body` fields, then `prompt_cache_key`. A streamed
 * request adds `stream` and `stream_options` last
 * (`agent/chat_completion_helpers.py`, `_open_chat_stream`).
 */
export function buildChatBody(input: ModelCallInput): string {
  const o = input.options ?? {};
  const planned = planPromptCache(input.messages, input.tools, { mode: "chat_completions", model: input.model, baseUrl: o.baseUrl, promptCaching: o.promptCaching, staticSystemPrefix: o.staticSystemPrefix });
  const messages = swapDeveloperRole(convertMessagesChat(planned, o.baseUrl, input.model), input.model);
  const body: Dict = { model: input.model, messages };
  if (o.temperature !== undefined && o.temperature !== null) body.temperature = o.temperature;
  if (input.tools.length > 0) body.tools = input.tools;
  if (o.maxTokens !== undefined && o.maxTokens !== null) body[o.maxTokensParam ?? "max_tokens"] = o.maxTokens;
  if (o.extraBody) Object.assign(body, o.extraBody);
  if (o.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return JSON.stringify(body);
}

/** A finish reason in the OpenAI vocabulary. `message_sanitization.py:normalize_finish_reason`. */
export function normalizeFinishReason(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  const lower = raw.toLowerCase();
  return ({ max_tokens: "length", end: "stop", function_call: "tool_calls" } as Record<string, string>)[lower] ?? lower;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function usageOf(u: unknown): Usage {
  const o = isDict(u) ? u : {};
  const details = isDict(o.prompt_tokens_details) ? o.prompt_tokens_details : {};
  return { promptTokens: num(o.prompt_tokens), completionTokens: num(o.completion_tokens), cachedTokens: num(details.cached_tokens) };
}

/** Read a chat_completions answer (`normalize_response`). Returns a string when the body is not an answer. */
export function parseChatResponse(json: unknown): NormalizedResponse | string {
  if (!isDict(json)) return "the model answer is not an object";
  if (!Array.isArray(json.choices) || json.choices.length === 0) return "the model answer has no choices";
  const choice = json.choices[0];
  const m = isDict(choice) ? choice.message : undefined;
  if (!isDict(m)) return "the first choice has no message";
  const calls: ToolCallWire[] = [];
  for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
    // Upstream drops a call with no function or name (`_normalize_tool_call` returns None).
    if (!isDict(c) || !isDict(c.function) || typeof c.function.name !== "string") continue;
    if (typeof c.id !== "string") return "a tool call in the model answer is malformed";
    const extra = isDict(c.extra_content) ? { extra_content: c.extra_content } : {};
    calls.push({ id: c.id, type: "function", function: { name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : "{}" }, ...extra });
  }
  let content: string | null = typeof m.content === "string" ? m.content : null;
  let finish = normalizeFinishReason(choice.finish_reason) ?? "stop";
  const providerData: Dict = {};
  if (m.reasoning_content !== undefined && m.reasoning_content !== null) providerData.reasoning_content = m.reasoning_content;
  if (Array.isArray(m.reasoning_details) && m.reasoning_details.length > 0) providerData.reasoning_details = m.reasoning_details;
  // A refusal with no text and no tool call becomes the content. `normalize_response`.
  if (typeof m.refusal === "string" && m.refusal.trim()) {
    providerData.refusal = m.refusal;
    if (!(typeof content === "string" && content.trim()) && calls.length === 0) {
      content = m.refusal;
      if (finish === "stop") finish = "content_filter";
    }
  }
  const reasoning = typeof m.reasoning === "string" && m.reasoning ? m.reasoning : typeof m.reasoning_content === "string" && m.reasoning_content ? m.reasoning_content : null;
  return {
    content,
    toolCalls: calls,
    finishReason: finish,
    reasoning,
    usage: usageOf(json.usage),
    providerData: Object.keys(providerData).length > 0 ? providerData : null,
  };
}

/**
 * Add the chunks of a streamed answer into one message.
 * `auxiliary_client.py:_ChatStreamAccumulator`: content and reasoning pieces are
 * joined, tool-call fragments are merged by `index`, the last `usage` and
 * `finish_reason` win.
 */
export class ChatStreamAccumulator {
  readonly content: string[] = [];
  readonly reasoning: string[] = [];
  readonly reasoningDetails: unknown[] = [];
  readonly calls = new Map<number, { id: string; name: string; args: string[] }>();
  finishReason: string | null = null;
  usage: unknown = null;
  id = "";
  model = "";

  feed(chunk: unknown): void {
    if (!isDict(chunk)) return;
    if (typeof chunk.id === "string" && chunk.id) this.id = chunk.id;
    if (typeof chunk.model === "string" && chunk.model) this.model = chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!isDict(choice)) return;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!isDict(delta)) return;
    if (typeof delta.content === "string" && delta.content) this.content.push(delta.content);
    const r = typeof delta.reasoning === "string" && delta.reasoning ? delta.reasoning : typeof delta.reasoning_content === "string" && delta.reasoning_content ? delta.reasoning_content : "";
    if (r) this.reasoning.push(r);
    if (Array.isArray(delta.reasoning_details)) this.reasoningDetails.push(...delta.reasoning_details);
    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isDict(tc)) continue;
      const idx = typeof tc.index === "number" ? tc.index : 0;
      let acc = this.calls.get(idx);
      if (!acc) {
        acc = { id: "", name: "", args: [] };
        this.calls.set(idx, acc);
      }
      if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
      if (isDict(tc.function)) {
        if (typeof tc.function.name === "string" && tc.function.name) acc.name = tc.function.name;
        if (typeof tc.function.arguments === "string" && tc.function.arguments) acc.args.push(tc.function.arguments);
      }
    }
  }

  /** The final completion object, as a non-streamed answer would look. */
  finish(): Dict {
    const toolCalls = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, a]) => ({ id: a.id, type: "function", function: { name: a.name, arguments: a.args.join("") } }));
    const message: Dict = { role: "assistant", content: this.content.join("") };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (this.reasoning.length > 0) message.reasoning = this.reasoning.join("");
    if (this.reasoningDetails.length > 0) message.reasoning_details = this.reasoningDetails;
    return {
      id: this.id,
      model: this.model,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: this.finishReason ?? "stop" }],
      usage: this.usage,
    };
  }
}

/**
 * Read a streamed chat_completions body into a final message.
 * A stream that ends before the `[DONE]` marker, or with no chunk at all, is a
 * drop. The partial text is thrown away with the error.
 */
export async function readChatStream(body: ReadableStream<Uint8Array> | null): Promise<{ response: Dict; raw: string }> {
  const acc = new ChatStreamAccumulator();
  let done = false;
  let finished = false;
  const raw: string[] = [];
  for await (const ev of guardedEvents(body, "chat_completions")) {
    if (ev.data.trim() === "[DONE]") {
      done = true;
      break;
    }
    raw.push(ev.data);
    let chunk: unknown;
    try {
      chunk = JSON.parse(ev.data);
    } catch {
      throw new StreamDroppedError(`Malformed provider streaming response: ${ev.data.slice(0, 300)}`);
    }
    if (isDict(chunk) && isDict(chunk.error)) {
      throw new StreamDroppedError(`provider stream error: ${String(chunk.error.message ?? "unknown")}`);
    }
    acc.feed(chunk);
    if (acc.finishReason) finished = true;
  }
  if (!done && !finished) {
    throw new StreamDroppedError("chat_completions stream ended before the final chunk (possible upstream stream drop)");
  }
  return { response: acc.finish(), raw: raw.join("\n") };
}

