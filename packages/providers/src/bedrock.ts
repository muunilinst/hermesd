import { thinkingKwargs, forbidsSamplingParams } from "./anthropic.ts";
import { StreamDroppedError } from "./sse.ts";
import { type Dict, type Message, type ModelCallInput, type NormalizedResponse, type ToolCallWire, type ToolDefinition, type Usage, asList, isDict, truthy } from "./types.ts";

/**
 * The bedrock_converse mode (AWS Bedrock Runtime, Converse API).
 *
 * Upstream: `agent/bedrock_adapter.py` (`convert_messages_to_converse`,
 * `convert_tools_to_converse`, `build_converse_kwargs`, `normalize_converse_response`,
 * `stream_converse_with_callbacks`) and `agent/transports/bedrock.py`.
 *
 * Upstream calls boto3. Here the request is the plain REST call
 * `POST /model/{modelId}/converse[-stream]`, so two things change: `modelId` moves
 * from the body to the path, and binary fields (`redactedContent`, image `bytes`) are base64
 * strings. Signing is not done here. An injectable `RequestSigner` adds the SigV4
 * (or bearer) headers.
 */

const EMPTY_TEXT_PLACEHOLDER = "(empty)";
const CACHE_POINT = { cachePoint: { type: "default" } };
const placeholderBlock = (): Dict => ({ text: EMPTY_TEXT_PLACEHOLDER });
const CACHE_POINT_PATTERNS = ["anthropic.claude", "amazon.nova"];
const NON_TOOL_CALLING_PATTERNS = ["deepseek.r1", "deepseek-r1", "amazon.titan", "amazon.nova-micro"];
const CONVERSE_REPLAY_STRIP = ["deepseek.r1", "deepseek-r1", "moonshotai.kimi-k3"];
const CONVERSE_REPLAY_ISSUER = ["openai.gpt-6"];
/** The `reasoning_details` record that names the model which minted a turn's reasoning. */
export const CONVERSE_ISSUER_TYPE = "bedrock.native_assistant";
const ANTHROPIC_BEDROCK_MODEL_RE = /^(?:[a-z]+\.)?anthropic\.claude/i;

export interface RequestSigner {
  /**
   * Return the headers to add to a request (for SigV4: `authorization`, `x-amz-date`,
   * `x-amz-security-token`, `x-amz-content-sha256`). The request is final; the signer must not change it.
   */
  sign(req: { method: string; url: string; headers: Record<string, string>; body: string; region: string; service: "bedrock" }): Promise<Record<string, string>>;
}

/** A signer for the Bedrock bearer-token mode (`AWS_BEARER_TOKEN_BEDROCK`). */
export function bearerSigner(token: string): RequestSigner {
  return { sign: async () => ({ authorization: `Bearer ${token}` }) };
}

// ---------------------------------------------------------------- tools and content

const isAnthropicBedrockModel = (id: string): boolean => ANTHROPIC_BEDROCK_MODEL_RE.test(id);
const modelSupportsToolUse = (id: string): boolean => !NON_TOOL_CALLING_PATTERNS.some((p) => id.toLowerCase().includes(p));
const modelSupportsPromptCache = (id: string): boolean => CACHE_POINT_PATTERNS.some((p) => id.toLowerCase().includes(p));

/** `convert_tools_to_converse` */
export function convertToolsToConverse(tools: ToolDefinition[]): Dict[] {
  return (tools ?? []).map((t) => {
    const fn = (t.function ?? {}) as Dict;
    return { toolSpec: { name: fn.name ?? "", description: fn.description ?? "", inputSchema: { json: fn.parameters ?? { type: "object", properties: {} } } } };
  });
}

function safeText(text: unknown): string {
  const s = text === null || text === undefined ? "" : String(text);
  return s.trim() ? s : EMPTY_TEXT_PLACEHOLDER;
}

function imageBlockFromDataUrl(url: string): Dict {
  const comma = url.indexOf(",");
  const header = comma < 0 ? url : url.slice(0, comma);
  const data = comma < 0 ? "" : url.slice(comma + 1);
  const media = (header.startsWith("data:") ? header.slice(5).split(";")[0] : "") || "image/jpeg";
  // The REST body carries the bytes as base64, so the data is passed through.
  return { image: { format: media.includes("/") ? media.split("/").pop() : "jpeg", source: { bytes: data } } };
}

function convertContentToConverse(content: unknown): Dict[] {
  if (!Array.isArray(content)) return [{ text: safeText(content) }];
  const blocks: Dict[] = [];
  for (const part of content) {
    if (typeof part === "string") blocks.push({ text: safeText(part) });
    else if (isDict(part) && (part.type ?? "") === "text") blocks.push({ text: safeText(part.text ?? "") });
    else if (isDict(part) && (part.type ?? "") === "image_url") {
      const iu = part.image_url ?? {};
      const url = isDict(iu) ? (iu.url ?? "") : "";
      blocks.push(url.startsWith("data:") ? imageBlockFromDataUrl(url) : { text: `[Image: ${url}]` });
    }
  }
  return blocks.length > 0 ? blocks : [placeholderBlock()];
}

function systemBlocks(content: unknown): Dict[] {
  const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
  const texts = parts.map((p) => (isDict(p) && p.type === "text" ? (p.text ?? "") : p));
  return texts.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((text) => ({ text }));
}

const toolUseBlock = (id: unknown, name: unknown, input: unknown): Dict => ({ toolUse: { toolUseId: id, name, input } });

function parseToolArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

const isBase64 = (s: string): boolean => /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0;
const redactedBlock = (encoded: unknown): Dict | null => (typeof encoded === "string" && encoded && isBase64(encoded) ? { reasoningContent: { redactedContent: encoded } } : null);
const reasoningTextBlock = (text: unknown, signature: unknown): Dict => {
  const rt: Dict = { text: typeof text === "string" ? text : "" };
  if (typeof signature === "string" && signature) rt.signature = signature;
  return { reasoningContent: { reasoningText: rt } };
};

/** `_replay_ordered_blocks`: rebuild the exact block sequence captured when the answer was normalized. */
function replayOrderedBlocks(ordered: unknown[]): Dict[] {
  const out: Dict[] = [];
  for (const block of ordered) {
    if (!isDict(block)) continue;
    if (typeof block.text === "string") out.push({ text: block.text });
    else if ("reasoningContent" in block) {
      const r = block.reasoningContent;
      if (!isDict(r)) continue;
      if (typeof r.text === "string") {
        const rt: Dict = { text: r.text };
        if (typeof r.signature === "string" && r.signature) rt.signature = r.signature;
        out.push({ reasoningContent: { reasoningText: rt } });
      }
      if (typeof r.redactedContentBase64 === "string" && r.redactedContentBase64) {
        const b = redactedBlock(r.redactedContentBase64);
        if (b) out.push(b);
      }
    } else if (isDict(block.toolUse)) {
      out.push(toolUseBlock(block.toolUse.toolUseId ?? "", block.toolUse.name ?? "", block.toolUse.input ?? {}));
    }
  }
  return out;
}

function anthropicOrderedBlocks(msg: Message): Dict[] {
  const args = new Map<unknown, unknown>();
  for (const tc of asList(msg.tool_calls)) if (isDict(tc)) args.set(tc.id, parseToolArgs((tc.function ?? {}).arguments ?? "{}"));
  const out: Dict[] = [];
  for (const b of asList(msg.anthropic_content_blocks)) {
    if (!isDict(b)) continue;
    let r: Dict | null = null;
    if (b.type === "thinking") r = reasoningTextBlock(b.thinking, b.signature);
    else if (b.type === "redacted_thinking") r = redactedBlock(b.data);
    else if (b.type === "text") r = typeof b.text === "string" && b.text.trim() ? { text: b.text } : null;
    else if (b.type === "tool_use") r = toolUseBlock(b.id ?? "", b.name ?? "", args.has(b.id) ? args.get(b.id) : (b.input ?? {}));
    if (r) out.push(r);
  }
  return out;
}

function reasoningDetailsBlocks(msg: Message, claude: boolean, own: boolean): Dict[] {
  const blocks: Dict[] = [];
  for (const d of asList(msg.reasoning_details)) {
    if (!isDict(d)) continue;
    if (d.type === "thinking" && typeof d.thinking === "string" && d.thinking.trim()) {
      if ((claude || own) && d.signature) blocks.push(reasoningTextBlock(d.thinking, d.signature));
      else if (!claude) blocks.push(reasoningTextBlock(d.thinking, null));
    } else if (d.type === "redacted_thinking") {
      const b = redactedBlock(d.data || d.redactedContentBase64);
      if (b) blocks.push(b);
    }
  }
  const text = msg.reasoning_content;
  if (blocks.length === 0 && !claude && typeof text === "string" && text.trim()) blocks.push(reasoningTextBlock(text, null));
  return blocks;
}

function assistantBlocks(msg: Message, content: unknown, claude: boolean, own: boolean): Dict[] {
  if (Array.isArray(msg.bedrock_content_blocks)) {
    const b = replayOrderedBlocks(msg.bedrock_content_blocks);
    if (b.length > 0) return b;
  }
  if (claude) {
    const b = anthropicOrderedBlocks(msg);
    if (b.length > 0) return b;
  }
  const blocks = reasoningDetailsBlocks(msg, claude, own);
  if (typeof content === "string" && content.trim()) blocks.push({ text: content });
  else if (Array.isArray(content)) blocks.push(...convertContentToConverse(content));
  for (const tc of asList(msg.tool_calls)) {
    const fn = (isDict(tc) ? tc.function : {}) ?? {};
    blocks.push(toolUseBlock((tc as Dict).id ?? "", fn.name ?? "", parseToolArgs(fn.arguments ?? "{}")));
  }
  return blocks;
}

// ---- reasoning replay policy per model: `bedrock_adapter.py:_converse_replay_policy` and `_reasoning_filter`

type Policy = "signed" | "strip" | "issuer" | "unsigned";
type Keep = (b: Dict) => Dict | null;

function replayPolicy(model: string | null): Policy {
  if (model === null) return "signed";
  const l = model.toLowerCase();
  if (l.includes("claude")) return "signed";
  if (CONVERSE_REPLAY_ISSUER.some((p) => l.includes(p))) return "issuer";
  return CONVERSE_REPLAY_STRIP.some((p) => l.includes(p)) ? "strip" : "unsigned";
}

const issuerOf = (msg: Message): string | null => {
  const d = asList(msg.reasoning_details).find((x) => isDict(x) && x.type === CONVERSE_ISSUER_TYPE && typeof x.model === "string") as Dict | undefined;
  return d ? d.model : null;
};
const mintedOutsideClaude = (issuer: string | null): boolean => issuer !== null && replayPolicy(issuer) !== "signed";

const verbatim: Keep = (b) => b;
const withoutReasoning: Keep = (b) => ("reasoningContent" in b ? null : b);
const unsignedReasoning: Keep = (b) => {
  const r = b.reasoningContent;
  if (!isDict(r)) return b;
  const text = (r.reasoningText ?? {}).text;
  return typeof text === "string" && text.trim() ? { reasoningContent: { reasoningText: { text } } } : null;
};
const FILTERS: Record<Policy, [Keep, Keep]> = {
  signed: [verbatim, verbatim],
  strip: [withoutReasoning, verbatim],
  unsigned: [unsignedReasoning, verbatim],
  issuer: [withoutReasoning, withoutReasoning],
};

function reasoningFilter(policy: Policy, issuer: string | null, own: boolean, inLoop: boolean): Keep {
  const [prior, loop] = FILTERS[policy];
  if (own) return inLoop || policy === "unsigned" || policy === "issuer" ? verbatim : prior;
  if (issuer !== null) return policy === "signed" && mintedOutsideClaude(issuer) ? withoutReasoning : prior;
  return inLoop ? loop : prior;
}

/** `convert_messages_to_converse`: returns `[system blocks or null, messages]`. */
export function convertMessagesToConverse(messages: Message[], model: string | null = null): [Dict[] | null, Dict[]] {
  const policy = replayPolicy(model);
  let loopStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      loopStart = i;
      break;
    }
  }
  const system: Dict[] = [];
  const msgs: Dict[] = [];
  const append = (role: string, blocks: Dict[]): void => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else msgs.push({ role, content: blocks });
  };
  messages.forEach((msg, idx) => {
    const role = msg.role ?? "";
    const content = msg.content;
    if (role === "system") system.push(...systemBlocks(content));
    else if (role === "tool") {
      const rc = typeof content === "string" ? content : JSON.stringify(content);
      append("user", [{ toolResult: { toolUseId: msg.tool_call_id ?? "", content: [{ text: safeText(rc) }] } }]);
    } else if (role === "assistant") {
      const issuer = model !== null ? issuerOf(msg) : null;
      const own = issuer !== null && issuer === model;
      const keep = reasoningFilter(policy, issuer, own, idx >= loopStart);
      const blocks = assistantBlocks(msg, content, policy === "signed", own).map(keep).filter((b): b is Dict => b !== null);
      append("assistant", blocks.length > 0 ? blocks : [placeholderBlock()]);
    } else if (role === "user") append("user", convertContentToConverse(content));
  });
  if (msgs.length > 0 && msgs[0]!.role !== "user") msgs.unshift({ role: "user", content: [placeholderBlock()] });
  if (msgs.length > 0 && msgs[msgs.length - 1]!.role !== "user") msgs.push({ role: "user", content: [placeholderBlock()] });
  return [system.length > 0 ? system : null, msgs];
}

// ---------------------------------------------------------------- request

/** The JSON body of a Converse call and the model id that goes into the URL. */
export interface ConverseRequest {
  modelId: string;
  body: string;
}

function claudeReasoning(model: string, rc: Dict, maxTokens: number | null): [Dict, Dict] {
  const thinking = thinkingKwargs(rc, model, maxTokens ?? 0);
  const fields: Dict = {};
  for (const k of ["thinking", "output_config"]) if (k in thinking) fields[k] = thinking[k];
  const inference: Dict = {};
  if ((fields.thinking ?? {}).type === "enabled") {
    if (!model.toLowerCase().includes("claude-3")) fields.anthropic_beta = ["interleaved-thinking-2025-05-14"];
    inference.temperature = thinking.temperature ?? 1;
    if (maxTokens !== null) inference.maxTokens = thinking.max_tokens ?? maxTokens;
  }
  return [fields, inference];
}

function novaReasoning(_model: string, rc: Dict): [Dict, Dict] {
  if (rc.enabled === false) return [{}, {}];
  const effort = ({ minimal: "low", low: "low", medium: "medium" } as Record<string, string>)[String(rc.effort ?? "medium").toLowerCase()] ?? "high";
  return [{ reasoningConfig: { type: "enabled", maxReasoningEffort: effort } }, effort === "high" ? { temperature: null, topP: null, maxTokens: null } : {}];
}

/**
 * `build_converse_kwargs`. Body keys: messages, inferenceConfig, system, toolConfig, guardrailConfig,
 * additionalModelRequestFields (upstream order, with `modelId` taken out into the URL).
 * `cachePoint` markers go on system, tools and the second-newest message when the model supports caching.
 */
export function buildConverseRequest(input: ModelCallInput): ConverseRequest {
  const o = input.options ?? {};
  const model = input.model;
  const [systemPrompt, converseMessages] = convertMessagesToConverse(input.messages, model);
  const cacheAt = modelSupportsPromptCache(model) ? new Set(["tools", "system", "messages"]) : new Set<string>();
  const maxTokens = o.maxTokens === undefined ? 4096 : o.maxTokens;
  const inference: Dict = maxTokens === null ? {} : { maxTokens };
  const kwargs: Dict = { messages: converseMessages, inferenceConfig: inference };
  if (systemPrompt) kwargs.system = cacheAt.has("system") ? [...systemPrompt, { ...CACHE_POINT }] : systemPrompt;
  if (!forbidsSamplingParams(model) && !/^(?:[a-z]+\.)?xai\.grok/i.test(model)) {
    if (o.temperature !== undefined && o.temperature !== null) inference.temperature = o.temperature;
  }
  const tools = input.tools.length > 0 ? convertToolsToConverse(input.tools) : [];
  if (tools.length > 0 && modelSupportsToolUse(model)) kwargs.toolConfig = { tools: cacheAt.has("tools") ? [...tools, { ...CACHE_POINT }] : tools };
  if (cacheAt.has("messages") && converseMessages.length >= 2) {
    const c = converseMessages[converseMessages.length - 2]!.content;
    if (Array.isArray(c) && c.length > 0) c.push({ ...CACHE_POINT });
  }
  if (o.guardrailConfig) kwargs.guardrailConfig = o.guardrailConfig;
  if (o.reasoningConfig) {
    const builder = isAnthropicBedrockModel(model) ? claudeReasoning : model.toLowerCase().includes("amazon.nova-2-lite") ? novaReasoning : null;
    if (builder) {
      const [fields, inf] = builder(model, o.reasoningConfig, maxTokens);
      if (Object.keys(fields).length > 0) kwargs.additionalModelRequestFields = fields;
      for (const [k, v] of Object.entries(inf)) {
        if (v === null) delete inference[k];
        else inference[k] = v;
      }
    }
  }
  if (Object.keys(inference).length === 0) delete kwargs.inferenceConfig; // optional on the wire; do not send {}
  return { modelId: model, body: JSON.stringify(kwargs) };
}

/** The URL of a Converse call. */
export function converseUrl(modelId: string, region: string, stream: boolean, baseUrl?: string | null): string {
  const base = (baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(/\/+$/, "");
  return `${base}/model/${encodeURIComponent(modelId)}/${stream ? "converse-stream" : "converse"}`;
}

// ---------------------------------------------------------------- response

const STOP_REASON_TO_FINISH: Record<string, string> = {
  end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", content_filtered: "content_filter", guardrail_intervened: "content_filter",
};

class ResponseParts {
  readonly text: string[] = [];
  readonly details: Dict[] = [];
  readonly calls: ToolCallWire[] = [];

  /** `_ResponseParts.absorb_reasoning`: the sync answer nests `reasoningText`; stream deltas are flat. */
  absorbReasoning(reasoning: unknown, block: Dict): void {
    if (!isDict(reasoning)) return;
    if (isDict(reasoning.reasoningText)) reasoning = { ...reasoning, ...reasoning.reasoningText };
    const r = reasoning as Dict;
    if (r.text) block.text = (block.text ?? "") + String(r.text);
    if (typeof r.signature === "string" && r.signature) block.signature = (block.signature ?? "") + r.signature;
    if (typeof r.redactedContent === "string" && r.redactedContent) {
      this.details.push({ type: "redacted_thinking", data: r.redactedContent });
      block.redactedContentBase64 = r.redactedContent;
    }
  }

  build(ordered: Dict[], usageData: Dict, stopReason: string): NormalizedResponse {
    const persisted: Dict[] = [];
    for (const b of ordered) {
      const r = b.reasoningContent;
      if (!isDict(r)) continue;
      if (typeof r.text === "string" && r.text) persisted.push({ type: "thinking", thinking: r.text, ...(r.signature ? { signature: r.signature } : {}) });
      if (r.redactedContentBase64) persisted.push({ type: "redacted_thinking", data: r.redactedContentBase64 });
    }
    const texts = ordered.filter((b) => isDict(b.reasoningContent) && b.reasoningContent.text).map((b) => b.reasoningContent.text as string);
    const n = (k: string): number => (typeof usageData[k] === "number" ? usageData[k] : 0);
    // Converse `inputTokens` excludes cache read and write tokens; OpenAI's prompt_tokens includes them.
    const prompt = n("inputTokens") + n("cacheReadInputTokens") + n("cacheWriteInputTokens");
    const usage: Usage = { promptTokens: prompt, completionTokens: n("outputTokens"), cachedTokens: n("cacheReadInputTokens") };
    let finish = STOP_REASON_TO_FINISH[stopReason] ?? "stop";
    if (this.calls.length > 0 && finish === "stop") finish = "tool_calls";
    const providerData: Dict = {};
    const rd = persisted.length > 0 ? persisted : this.details;
    if (rd.length > 0) providerData.reasoning_details = rd;
    if (ordered.length > 0) providerData.bedrock_content_blocks = ordered;
    if (texts.length > 0) providerData.reasoning_content = texts.join("\n\n");
    return {
      content: this.text.length > 0 ? this.text.join("\n") : null,
      toolCalls: this.calls,
      finishReason: finish,
      reasoning: texts.length > 0 ? texts.join("\n\n") : null,
      usage,
      providerData: Object.keys(providerData).length > 0 ? providerData : null,
    };
  }
}

const toolCall = (id: string, name: string, input: unknown): ToolCallWire => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });

/** `normalize_converse_response` */
export function parseConverseResponse(response: unknown): NormalizedResponse | string {
  if (!isDict(response) || !isDict(response.output)) return "the model answer has no output";
  const parts = new ResponseParts();
  const ordered: Dict[] = [];
  for (const block of asList(response.output.message?.content)) {
    if (!isDict(block)) continue;
    if ("text" in block) {
      parts.text.push(block.text);
      ordered.push({ text: block.text });
    } else if ("reasoningContent" in block) {
      const r: Dict = {};
      parts.absorbReasoning(block.reasoningContent, r);
      if (Object.keys(r).length > 0) ordered.push({ reasoningContent: r });
    } else if (isDict(block.toolUse)) {
      const tu = block.toolUse;
      ordered.push(toolUseBlock(tu.toolUseId ?? "", tu.name ?? "", tu.input ?? {}));
      parts.calls.push(toolCall(tu.toolUseId ?? "", tu.name ?? "", tu.input ?? {}));
    }
  }
  return parts.build(ordered, isDict(response.usage) ? response.usage : {}, String(response.stopReason ?? "end_turn"));
}

/**
 * `stream_converse_with_callbacks`, without the callbacks: add decoded stream events into one answer.
 * Blocks are keyed by `contentBlockIndex`. A stream with no `messageStop` is a drop.
 */
export function normalizeConverseStreamEvents(events: Iterable<Dict>): NormalizedResponse {
  const parts = new ResponseParts();
  const blocks = new Map<number, Dict>();
  let currentIndex: number | null = null;
  let currentTool: { id: string; name: string; json: string } | null = null;
  let buffer: string[] = [];
  let stopReason: string | null = null;
  let usage: Dict = {};
  const blockIndex = (payload: Dict, isNew = false): number => (typeof payload.contentBlockIndex === "number" ? payload.contentBlockIndex : isNew || currentIndex === null ? blocks.size : currentIndex);
  const flush = (): void => {
    if (buffer.length > 0) parts.text.push(buffer.join(""));
    buffer = [];
  };
  for (const event of events) {
    if (truthy(event.contentBlockStart)) {
      const idx = (currentIndex = blockIndex(event.contentBlockStart, true));
      const start = event.contentBlockStart.start ?? {};
      if (start.toolUse) {
        flush();
        currentTool = { id: start.toolUse.toolUseId ?? "", name: start.toolUse.name ?? "", json: "" };
        blocks.set(idx, toolUseBlock(currentTool.id, currentTool.name, {}));
      }
    } else if (truthy(event.contentBlockDelta)) {
      const idx = (currentIndex = blockIndex(event.contentBlockDelta));
      const delta = event.contentBlockDelta.delta ?? {};
      if ("text" in delta) {
        const b = blocks.get(idx) ?? { text: "" };
        blocks.set(idx, b);
        b.text = (b.text ?? "") + delta.text;
        buffer.push(delta.text);
      } else if (delta.toolUse && currentTool) {
        currentTool.json += delta.toolUse.input ?? "";
      } else if (delta.reasoningContent) {
        const r = delta.reasoningContent;
        if (isDict(r) && (r.text || r.signature || r.redactedContent)) {
          const b = blocks.get(idx) ?? { reasoningContent: {} };
          blocks.set(idx, b);
          parts.absorbReasoning(r, b.reasoningContent);
        }
      }
    } else if (truthy(event.contentBlockStop)) {
      const idx = blockIndex(event.contentBlockStop);
      currentIndex = null;
      if (currentTool) {
        const input = parseToolArgs(currentTool.json); // "" gives {} through the error path
        parts.calls.push(toolCall(currentTool.id, currentTool.name, input));
        if (blocks.get(idx)?.toolUse) blocks.get(idx)!.toolUse.input = input;
        currentTool = null;
      } else flush();
    } else if (event.messageStop) {
      stopReason = event.messageStop.stopReason ?? "end_turn";
    } else if (event.metadata) {
      const u = event.metadata.usage ?? {};
      usage = Object.fromEntries(["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheWriteInputTokens"].map((k) => [k, u[k] ?? 0]));
    }
  }
  if (stopReason === null) throw new StreamDroppedError("Bedrock Converse stream ended before messageStop; response is incomplete");
  flush();
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  return parts.build(ordered, usage, stopReason);
}

// ---------------------------------------------------------------- event stream framing

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode one `application/vnd.amazon.eventstream` frame. Used by the scripted model and by tests. */
export function encodeEventStreamFrame(eventType: string, payload: unknown, messageType: "event" | "exception" = "event"): Uint8Array {
  const enc = new TextEncoder();
  const header = (name: string, value: string): number[] => {
    const n = enc.encode(name);
    const v = enc.encode(value);
    return [n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v];
  };
  const headers = Uint8Array.from([...header(":event-type", eventType), ...header(":content-type", "application/json"), ...header(":message-type", messageType)]);
  const body = enc.encode(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, headers.length);
  dv.setUint32(8, crc32(out.subarray(0, 8)));
  out.set(headers, 12);
  out.set(body, 12 + headers.length);
  dv.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}

/**
 * Decode an event-stream body into Converse events (`{contentBlockDelta: {...}}`, ...).
 * A bad checksum, a cut frame, or a connection error is a drop. An `exception` frame throws its message.
 */
export async function* decodeEventStream(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Dict> {
  if (!body) throw new StreamDroppedError("Bedrock Converse stream has no body");
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  const dec = new TextDecoder();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") throw e;
        throw new StreamDroppedError(`Bedrock Converse stream connection broke: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (chunk.done) break;
      const merged = new Uint8Array(buf.length + chunk.value.length);
      merged.set(buf);
      merged.set(chunk.value, buf.length);
      buf = merged;
      while (buf.length >= 12) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const total = dv.getUint32(0);
        if (buf.length < total) break;
        const frame = buf.subarray(0, total);
        const fv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        if (crc32(frame.subarray(0, 8)) !== fv.getUint32(8) || crc32(frame.subarray(0, total - 4)) !== fv.getUint32(total - 4)) {
          throw new StreamDroppedError("Bedrock Converse stream frame failed its checksum");
        }
        const hlen = fv.getUint32(4);
        const headers = parseHeaders(frame.subarray(12, 12 + hlen));
        const payload = frame.subarray(12 + hlen, total - 4);
        buf = buf.slice(total);
        const text = dec.decode(payload);
        if (headers[":message-type"] === "exception") {
          let m = text;
          try {
            m = String(JSON.parse(text).message ?? text);
          } catch {
            /* keep text */
          }
          throw new StreamDroppedError(`${headers[":exception-type"] ?? headers[":event-type"] ?? "exception"}: ${m}`);
        }
        const type = headers[":event-type"];
        if (type) yield { [type]: text ? JSON.parse(text) : {} };
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buf.length > 0) throw new StreamDroppedError("Bedrock Converse stream ended in the middle of a frame");
}

function parseHeaders(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  let i = 0;
  while (i < b.length) {
    const nl = b[i++]!;
    const name = dec.decode(b.subarray(i, i + nl));
    i += nl;
    const type = b[i++]!;
    if (type === 7) {
      const vl = (b[i]! << 8) | b[i + 1]!;
      i += 2;
      out[name] = dec.decode(b.subarray(i, i + vl));
      i += vl;
    } else {
      throw new StreamDroppedError(`Bedrock Converse stream header type ${type} is not supported`);
    }
  }
  return out;
}
