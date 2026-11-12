import { sha256Hex } from "./sha256.ts";
import { StreamDroppedError, guardedEvents } from "./sse.ts";
import { type Dict, type Message, type ModelCallInput, type NormalizedResponse, type ToolCallWire, type ToolDefinition, type Usage, asList, isDict, nonBlank } from "./types.ts";

/**
 * The codex_responses mode (OpenAI Responses API).
 *
 * Upstream files:
 * - `agent/codex_responses_adapter.py`: `_chat_messages_to_responses_input`,
 *   `_responses_tools`, `_normalize_codex_response`.
 * - `agent/transports/codex.py`: `ResponsesApiTransport.build_kwargs`,
 *   `_content_cache_key`, `_reasoning_fields`.
 *
 * Not ported (see NOTES.md): native server-side compaction, xAI and OpenCode
 * quirks, reserved tool-name aliases, tool-call leak recovery, per-model effort ladders.
 */

const MAX_ITEM_ID_LENGTH = 64;
const INCOMPLETE_STATUSES = new Set(["queued", "in_progress", "incomplete"]);
const MESSAGE_STATUSES = new Set(["completed", "incomplete", "in_progress"]);
const OUTPUT_TEXT_TYPES = new Set(["output_text", "text"]);
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);
const IMAGE_PART_TYPES = new Set(["image_url", "input_image"]);
const ROLE_MESSAGE_PHASES = new Set(["commentary", "final_answer"]);
const SERVER_SIDE_TOOL_CALL_TYPES = new Set(["web_search_call", "file_search_call", "code_interpreter_call", "image_generation_call", "computer_call"]);
const ASSISTANT_IMAGE_PLACEHOLDER = "[Assistant image omitted during replay]";
/** Issuer kinds for which a `completed` status with reasoning only does not count as final. */
const UNTRUSTED_COMPLETED_ISSUERS = new Set(["codex_backend", "xai_responses"]);

const lowerOrNull = (v: unknown): string | null => (typeof v === "string" ? v.trim().toLowerCase() || null : null);
const strOrEmpty = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** `deterministic_call_id` in `message_sanitization.py`. */
export function deterministicCallId(name: string, args: string, index = 0): string {
  return `call_${sha256Hex(`${name}:${args}:${index}`).slice(0, 12)}`;
}

/** `coerce_tool_name` in `message_sanitization.py`. */
export function coerceToolName(name: unknown, fallback = "invalid_tool_call"): string {
  if (typeof name !== "string") return fallback;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
  const coerced = name.trim().replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return coerced.slice(0, 64) || fallback;
}

/** Python `json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"))`. */
export function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (isDict(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ---------------------------------------------------------------- ids

function clampCallId(callId: string): string {
  return callId.length <= MAX_ITEM_ID_LENGTH ? callId : `call_${sha256Hex(callId).slice(0, 32)}`;
}

function canonicalCallIdFromFc(itemId: unknown): string | null {
  return typeof itemId === "string" && itemId.startsWith("fc_") && itemId.length > 3 ? `call_${itemId.slice(3)}` : null;
}

function splitToolId(raw: unknown): [string | null, string | null] {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.includes("|")) {
    const i = value.indexOf("|");
    return [value.slice(0, i).trim() || null, value.slice(i + 1).trim() || null];
  }
  if (!value) return [null, null];
  return value.startsWith("fc_") ? [null, value] : [value, null];
}

function resolveCallId(rawCallId: unknown, rawItemId: unknown, name: string, args: string, index: number, canonicalizeFc: boolean): string {
  const [embeddedCall, embeddedItem] = splitToolId(rawItemId);
  let callId: string | null = nonBlank(rawCallId) ? rawCallId : embeddedCall;
  if (!nonBlank(callId) && canonicalizeFc) callId = canonicalCallIdFromFc(embeddedItem);
  if (!nonBlank(callId)) callId = deterministicCallId(name, args, index);
  return callId.trim();
}

/** `_derive_responses_function_call_id`: a valid `function_call.id` starts with `fc_`. */
function deriveFunctionCallId(callId: string, responseItemId?: string | null): string {
  if (typeof responseItemId === "string" && responseItemId.trim().startsWith("fc_")) return responseItemId.trim();
  const source = (callId ?? "").trim();
  const sanitized = source.replace(/[^A-Za-z0-9_-]/g, "");
  for (const c of [source, sanitized]) {
    if (c.startsWith("fc_") || (c.startsWith("call_") && c.length > "call_".length)) return c.startsWith("fc_") ? c : `fc_${c.slice("call_".length)}`;
  }
  if (sanitized) return `fc_${sanitized.slice(0, 48)}`;
  return `fc_${sha256Hex(source || String(responseItemId ?? "")).slice(0, 24)}`;
}

/**
 * Wire ids for replayed tool pairs. Stored call ids can recur on later turns, and a strict
 * Responses validator rejects a duplicate. Every use after the first gets a `_dup<n>` id; the
 * matching output takes the id its call was given. `_WireCallIds` upstream.
 */
class WireCallIds {
  readonly #seen = new Map<string, number>();
  readonly #queue = new Map<string, string[]>();
  forCall(callId: string): string {
    const base = clampCallId(callId);
    const n = this.#seen.get(base) ?? 0;
    this.#seen.set(base, n + 1);
    const wire = n === 0 ? base : clampCallId(`${base}_dup${n}`);
    const q = this.#queue.get(base) ?? [];
    q.push(wire);
    this.#queue.set(base, q);
    return wire;
  }
  forOutput(callId: string): string {
    const base = clampCallId(callId);
    return this.#queue.get(base)?.shift() ?? base;
  }
}

// ---------------------------------------------------------------- tools and content

/** `_responses_tools`. Returns null when no tool is usable: the field must be left out. */
export function responsesTools(tools: ToolDefinition[]): Dict[] | null {
  const converted = (tools ?? [])
    .map((t) => (isDict(t) ? ((t.function ?? {}) as Dict) : {}))
    .filter((fn) => nonBlank(fn.name))
    .map((fn) => ({
      type: "function",
      name: fn.name,
      description: fn.description ?? "",
      strict: typeof fn.strict === "boolean" ? fn.strict : false,
      parameters: fn.parameters ?? { type: "object", properties: {} },
    }));
  return converted.length > 0 ? converted : null;
}

const textTypeFor = (role: string): string => (role === "assistant" ? "output_text" : "input_text");

function inputImagePart(part: Dict, role: string): Dict | null {
  if (role === "assistant") return { type: "output_text", text: ASSISTANT_IMAGE_PLACEHOLDER };
  let url = part.image_url;
  let detail = part.detail;
  if (isDict(url)) {
    detail = url.detail ?? detail;
    url = url.url;
  }
  if (!(typeof url === "string" && url.length > 0)) return null;
  const out: Dict = { type: "input_image", image_url: url };
  if (nonBlank(detail)) out.detail = detail.trim();
  return out;
}

function chatContentToResponsesParts(content: unknown, role = "user"): Dict[] {
  for (const part of asList(content)) {
    const t = isDict(part) ? String(part.type ?? "").trim().toLowerCase() : "";
    if (["video", "video_url", "input_video"].includes(t)) throw new Error(`Codex Responses does not support ${t} input; use a video-capable provider.`);
  }
  const out: Dict[] = [];
  for (const part of asList(content)) {
    if (typeof part === "string" && part) out.push({ type: textTypeFor(role), text: part });
    else if (isDict(part)) {
      const t = String(part.type ?? "").trim().toLowerCase();
      if (TEXT_PART_TYPES.has(t) && typeof part.text === "string" && part.text) out.push({ type: textTypeFor(role), text: part.text });
      else if (IMAGE_PART_TYPES.has(t)) {
        const img = inputImagePart(part, role);
        if (img) out.push(img);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- history to input

function normalizeStatus(v: unknown, dflt = "completed"): string {
  const s = typeof v === "string" ? v.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_") : null;
  return s && MESSAGE_STATUSES.has(s) ? s : dflt;
}

function messageItem(content: Dict[], status: string, itemId?: string | null, phase?: string | null): Dict {
  const item: Dict = { type: "message", role: "assistant", status, content };
  if (itemId) item.id = itemId;
  if (phase) item.phase = phase;
  return item;
}

function roleMessageItem(role: string, content: unknown, phase?: unknown): Dict {
  const item: Dict = { type: "message", role, content };
  if (role === "assistant") {
    const cleaned = lowerOrNull(phase);
    if (cleaned && ROLE_MESSAGE_PHASES.has(cleaned)) item.phase = cleaned;
  }
  return item;
}

function replayReasoningItems(msg: Message, seenIds: Set<string>, issuerKind: string | null, issuerModel: string | null): Dict[] {
  const out: Dict[] = [];
  for (const ri of asList(msg.codex_reasoning_items)) {
    if (!(isDict(ri) && ri.encrypted_content)) continue;
    const id = ri.id;
    // A compaction checkpoint is replayed only when the request carries `context_management`; this port never sends it.
    if ((id && seenIds.has(id)) || ri.type === "compaction") continue;
    const foreignIssuer = issuerKind !== null && typeof ri._issuer_kind === "string" && ri._issuer_kind !== issuerKind;
    const foreignModel = issuerModel !== null && typeof ri._issuer_model === "string" && ri._issuer_model !== issuerModel;
    if (foreignIssuer || foreignModel) continue; // the blob is sealed to its issuer and model
    out.push(Object.fromEntries(Object.entries(ri).filter(([k]) => !["id", "_issuer_kind", "_issuer_model"].includes(k))));
    if (id) seenIds.add(id);
  }
  return out;
}

function assistantMessageItem(raw: Dict, content: Dict[], dropIds: boolean, issuerKind: string | null): Dict {
  const itemId = raw.id;
  const phase = raw.phase;
  let keep = !dropIds && nonBlank(itemId) && itemId.trim().length <= MAX_ITEM_ID_LENGTH;
  if (keep && issuerKind === "codex_backend" && !itemId.trim().startsWith("msg")) keep = false;
  return messageItem(content, normalizeStatus(raw.status), keep ? itemId.trim() : null, nonBlank(phase) ? phase.trim() : null);
}

function replayMessageItems(msg: Message, dropIds: boolean, issuerKind: string | null): Dict[] {
  const out: Dict[] = [];
  const linked = Boolean(msg.codex_reasoning_trimmed) || asList(msg.codex_reasoning_items).some((ri) => isDict(ri) && ri.encrypted_content);
  for (let raw of asList(msg.codex_message_items)) {
    if (!(isDict(raw) && raw.type === "message" && raw.role === "assistant")) continue;
    const content = asList(raw.content)
      .filter((p) => isDict(p) && OUTPUT_TEXT_TYPES.has(String(p.type ?? "").trim()))
      .map((p) => ({ type: "output_text", text: strOrEmpty((p as Dict).text ?? "") }));
    if (content.length === 0) continue;
    // A message id minted next to a reasoning item is bound to it; the reasoning id is stripped, so the message id must go too.
    if (linked && raw.id) raw = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "id"));
    out.push(assistantMessageItem(raw as Dict, content, dropIds, issuerKind));
  }
  return out;
}

function coerceArguments(a: unknown): string {
  const s = isDict(a) || Array.isArray(a) ? JSON.stringify(a) : typeof a === "string" ? a : String(a);
  return s.trim() || "{}";
}

function replayToolCallItems(msg: Message, startIndex: number, wire: WireCallIds): Dict[] {
  const out: Dict[] = [];
  for (const tc of asList(msg.tool_calls)) {
    if (!isDict(tc)) continue;
    const fn = (tc.function ?? {}) as Dict;
    if (!nonBlank(fn.name)) continue;
    const args = fn.arguments ?? "{}";
    const callId = resolveCallId(tc.call_id, tc.id, fn.name, String(args), startIndex + out.length, true);
    out.push({ type: "function_call", call_id: wire.forCall(callId), name: coerceToolName(fn.name, "fn"), arguments: coerceArguments(args) });
  }
  return out;
}

function toolOutputItems(msg: Message, wire: WireCallIds): Dict[] {
  const raw = msg.tool_call_id;
  let [callId, itemId] = splitToolId(raw);
  if (!nonBlank(callId)) {
    callId = canonicalCallIdFromFc(itemId);
    if (callId === null && nonBlank(raw)) callId = raw.trim();
  }
  if (!nonBlank(callId)) return [];
  const content = msg.content;
  const parts = Array.isArray(content) ? chatContentToResponsesParts(content) : [];
  const output: unknown = Array.isArray(content) ? (parts.length > 0 ? parts : "") : String(truthyStr(content));
  return [{ type: "function_call_output", call_id: wire.forOutput(callId), output }];
}

const truthyStr = (v: unknown): string => (v === null || v === undefined || v === false || v === 0 ? "" : String(v));

export interface InputOptions {
  dropReplayItemIds?: boolean;
  replayEncryptedReasoning?: boolean;
  issuerKind?: string | null;
  issuerModel?: string | null;
}

/** `_chat_messages_to_responses_input` */
export function chatMessagesToResponsesInput(messages: Message[], opts: InputOptions = {}): Dict[] {
  const items: Dict[] = [];
  const seen = new Set<string>();
  const wire = new WireCallIds();
  const issuerKind = opts.issuerKind ?? null;
  const typedTextOnly = issuerKind === "codex_backend"; // that backend rejects a plain string content
  for (const msg of messages) {
    if (!isDict(msg)) continue;
    const role = msg.role;
    if (role === "tool") {
      items.push(...toolOutputItems(msg, wire));
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const content = msg.content ?? "";
    const parts = chatContentToResponsesParts(content, role);
    const tt = textTypeFor(role);
    const text = Array.isArray(content) ? parts.filter((p) => p.type === tt).map((p) => p.text).join("") : strOrEmpty(content);
    const wireContent = (v: unknown): unknown => (typedTextOnly && typeof v === "string" ? [{ type: tt, text: v }] : v);
    if (role === "user") {
      items.push(roleMessageItem(role, wireContent(parts.length > 0 ? parts : text)));
      continue;
    }
    const reasoning = opts.replayEncryptedReasoning === false ? [] : replayReasoningItems(msg, seen, issuerKind, opts.issuerModel ?? null);
    items.push(...reasoning);
    const messageItems = replayMessageItems(msg, opts.dropReplayItemIds ?? false, issuerKind);
    items.push(...messageItems);
    let fallback: unknown = null;
    if (messageItems.length === 0) fallback = parts.length > 0 ? parts : text.trim() ? text : reasoning.length > 0 ? "" : null;
    const tools = replayToolCallItems(msg, items.length + (fallback !== null ? 1 : 0), wire);
    if (fallback !== null && !(fallback === "" && tools.length > 0)) {
      items.push(roleMessageItem("assistant", wireContent(fallback === "" ? " " : fallback), msg.phase));
    }
    items.push(...tools);
  }
  return items;
}

// ---------------------------------------------------------------- request

/** `transports/codex.py:_content_cache_key`: `pck_` plus 24 hex of the hash of scope, instructions and name-sorted tools. */
export function contentCacheKey(instructions: string, tools: Dict[] | null, scopeId = ""): string | null {
  if (!instructions && !(tools && tools.length > 0)) return null;
  let toolsPart = "";
  if (tools && tools.length > 0) {
    const sorted = tools.filter(isDict).sort((a, b) => {
      const ka = String(a.name || a.type || "");
      const kb = String(b.name || b.type || "");
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    toolsPart = sortedJson(sorted);
  }
  return `pck_${sha256Hex(`${scopeId}\x00${instructions || ""}\x00${toolsPart}`).slice(0, 24)}`;
}

/** `_cache_scope_from_session_id`: a cron fire keeps one scope for all fires of the job. */
export function cacheScopeFromSessionId(sessionId: string | null | undefined): string {
  const sid = String(sessionId ?? "");
  const m = /^(cron_.+)_\d{8}_\d{6}$/.exec(sid);
  return m ? m[1]! : sid;
}

/** `_bounded_prompt_cache_key`: at most 64 characters. */
export function boundedCacheKey(value: unknown): string | null {
  const key = value === null || value === undefined ? "" : String(value).trim();
  if (!key) return null;
  return key.length <= 64 ? key : `pck_${sha256Hex(key).slice(0, 24)}`;
}

/** The default agent identity used when the system prompt is empty. `prompt_builder.py:DEFAULT_AGENT_IDENTITY` is set by the prompt package; this is only the fallback. */
export const DEFAULT_AGENT_IDENTITY = "You are Hermes Agent, an intelligent AI assistant created by Nous Research.";

/**
 * `ResponsesApiTransport.build_kwargs`. Key order: model, instructions, input, store,
 * tools, tool_choice, parallel_tool_calls, prompt_cache_key, reasoning, include,
 * max_output_tokens (not for the Codex backend), then `extraBody`.
 */
export function buildCodexBody(input: ModelCallInput): string {
  const o = input.options ?? {};
  let instructions = "";
  let payload = input.messages;
  const first = input.messages[0];
  if (first && first.role === "system") {
    instructions = String(first.content ?? "").trim();
    payload = input.messages.slice(1);
  }
  instructions ||= DEFAULT_AGENT_IDENTITY;
  const issuerKind = o.issuerKind ?? null;
  const tools = responsesTools(input.tools);
  const kwargs: Dict = {
    model: input.model,
    instructions,
    input: chatMessagesToResponsesInput(payload, { issuerKind, issuerModel: input.model }),
    store: false,
  };
  if (tools) {
    kwargs.tools = tools;
    kwargs.tool_choice = "auto";
    kwargs.parallel_tool_calls = true;
  }
  const scope = cacheScopeFromSessionId(o.sessionId);
  const cacheKey = contentCacheKey(instructions, tools, scope) ?? scope;
  if (cacheKey) kwargs.prompt_cache_key = boundedCacheKey(cacheKey);
  // `_reasoning_fields` for the generic route: effort and summary, with the encrypted blob requested for replay.
  const rc = o.reasoningConfig ?? {};
  const enabled = rc.enabled !== false;
  if (enabled) {
    kwargs.reasoning = { effort: rc.effort || "medium", summary: "auto" };
    kwargs.include = ["reasoning.encrypted_content"];
  } else {
    kwargs.include = [];
    kwargs.reasoning = { effort: "none" };
  }
  if (o.maxTokens !== undefined && o.maxTokens !== null && issuerKind !== "codex_backend") kwargs.max_output_tokens = o.maxTokens;
  if (o.extraBody) Object.assign(kwargs, o.extraBody);
  if (o.stream) kwargs.stream = true;
  if (!kwargs.prompt_cache_key) delete kwargs.prompt_cache_key;
  return JSON.stringify(kwargs);
}

// ---------------------------------------------------------------- response

function extractMessageText(item: Dict): string {
  const chunks: string[] = [];
  for (const part of asList(item.content)) {
    if (!isDict(part)) continue;
    const text = part.type === "refusal" ? part.refusal : OUTPUT_TEXT_TYPES.has(part.type) ? part.text : null;
    if (typeof text === "string" && text) chunks.push(text);
  }
  return chunks.join("").trim();
}

function extractReasoningText(item: Dict): string {
  const chunks = asList(item.summary).filter((p) => isDict(p) && typeof p.text === "string" && p.text).map((p) => (p as Dict).text as string);
  if (chunks.length > 0) return chunks.join("\n").trim();
  return typeof item.text === "string" ? item.text.trim() : "";
}

export function formatResponsesError(error: unknown, status: string): string {
  const field = (n: string): string => {
    const v = isDict(error) ? error[n] : undefined;
    return typeof v === "string" ? v.trim() : v ? String(v).trim() : "";
  };
  const code = field("code");
  const message = field("message");
  if (code && message) return `${code}: ${message}`;
  return message || code || (error ? String(error) : `Responses API returned status '${status}'`);
}

function captureEncrypted(item: Dict, type: string, issuerKind: string | null, issuerModel: string | null): Dict | null {
  if (!(typeof item.encrypted_content === "string" && item.encrypted_content)) return null;
  const raw: Dict = { type, encrypted_content: item.encrypted_content };
  if (issuerKind) raw._issuer_kind = issuerKind;
  if (issuerModel) raw._issuer_model = issuerModel;
  if (type !== "reasoning") return raw;
  if (typeof item.id === "string" && item.id.startsWith("rs_tmp_")) return null; // transient
  if (nonBlank(item.id)) raw.id = item.id;
  if (Array.isArray(item.summary)) raw.summary = item.summary.filter((p) => isDict(p) && typeof p.text === "string").map((p) => ({ type: "summary_text", text: p.text }));
  return raw;
}

function responsesUsage(u: unknown): Usage {
  const o = isDict(u) ? u : {};
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const d = isDict(o.input_tokens_details) ? o.input_tokens_details : {};
  return { promptTokens: n(o.input_tokens), completionTokens: n(o.output_tokens), cachedTokens: n(d.cached_tokens) };
}

/**
 * `_normalize_codex_response` plus the tool-call build of `transports/codex.py:normalize_response`.
 * Throws on a `failed` or `cancelled` response, as upstream does.
 */
export function parseCodexResponse(response: unknown, issuerKind: string | null = null, issuerModel: string | null = null): NormalizedResponse {
  if (!isDict(response)) throw new Error("Responses API returned no output items");
  const status = lowerOrNull(response.status);
  const reason = String(isDict(response.incomplete_details) ? (response.incomplete_details.reason ?? "") : "").trim().toLowerCase();
  const contentFilter = status === "incomplete" && reason === "content_filter";
  let output = response.output;
  if (!Array.isArray(output) || output.length === 0) {
    const outText = typeof response.output_text === "string" ? response.output_text.trim() : "";
    if (outText) output = [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: outText }] }];
    else if (contentFilter) output = [{ type: "message", role: "assistant", status: "completed", content: [] }];
    else throw new Error("Responses API returned no output items");
  }
  if (status === "failed" || status === "cancelled") throw new Error(formatResponsesError(response.error, status));

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const reasoningRaw: Dict[] = [];
  const messageRaw: Dict[] = [];
  const calls: ToolCallWire[] = [];
  let hasIncomplete = status !== null && INCOMPLETE_STATUSES.has(status);
  let sawStreamingOrItemIncomplete = status === "queued" || status === "in_progress";
  let sawCommentary = false;
  let sawFinal = false;
  let sawReasoning = false;
  for (const item of output as Dict[]) {
    const type = item.type;
    const istatus = lowerOrNull(item.status);
    if (istatus && INCOMPLETE_STATUSES.has(istatus) && !SERVER_SIDE_TOOL_CALL_TYPES.has(type)) {
      hasIncomplete = true;
      sawStreamingOrItemIncomplete = true;
    }
    if (type === "message") {
      const phase = lowerOrNull(item.phase);
      const commentary = phase === "commentary" || phase === "analysis";
      sawCommentary ||= commentary;
      sawFinal ||= phase === "final_answer" || phase === "final";
      const text = extractMessageText(item);
      if (!text) continue;
      (commentary ? reasoningParts : contentParts).push(text);
      messageRaw.push(messageItem([{ type: "output_text", text }], normalizeStatus(istatus), typeof item.id === "string" ? item.id : null, phase));
    } else if (type === "reasoning" || type === "compaction") {
      if (type === "reasoning") {
        sawReasoning = true;
        const t = extractReasoningText(item);
        if (t) reasoningParts.push(t);
      }
      const raw = captureEncrypted(item, type, issuerKind, issuerModel);
      if (raw) reasoningRaw.push(raw);
    } else if (type === "custom_tool_call" || (type === "function_call" && !(istatus && INCOMPLETE_STATUSES.has(istatus)))) {
      const name = item.name || "";
      let args = type === "function_call" ? (item.arguments ?? "{}") : (item.input ?? "{}");
      if (typeof args !== "string") args = JSON.stringify(args);
      const rawItemId = typeof item.id === "string" ? item.id : null;
      const callId = resolveCallId(item.call_id, rawItemId, name, args, calls.length, false);
      calls.push({ id: callId, type: "function", function: { name, arguments: args }, call_id: callId, response_item_id: deriveFunctionCallId(callId, rawItemId) });
    }
  }
  const finalText = contentParts.join("\n").trim() || (sawFinal || !sawCommentary ? (typeof response.output_text === "string" ? response.output_text.trim() : "") : "");
  const reasoningOnly = (reasoningRaw.length > 0 || reasoningParts.length > 0 || sawReasoning) && !finalText;
  const trustedFinal = status === "completed" && !(issuerKind !== null && UNTRUSTED_COMPLETED_ISSUERS.has(issuerKind));
  let finish: string;
  if (calls.length > 0) finish = "tool_calls";
  else if (contentFilter) finish = "content_filter";
  else if (sawStreamingOrItemIncomplete || ((hasIncomplete || sawCommentary) && !sawFinal) || (reasoningOnly && !trustedFinal)) finish = "incomplete";
  else finish = "stop";
  const providerData: Dict = {};
  if (reasoningRaw.length > 0) providerData.codex_reasoning_items = reasoningRaw;
  if (messageRaw.length > 0) providerData.codex_message_items = messageRaw;
  return {
    content: finalText,
    toolCalls: calls,
    finishReason: finish,
    reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n\n").trim() : null,
    usage: responsesUsage(response.usage),
    providerData: Object.keys(providerData).length > 0 ? providerData : null,
  };
}

/**
 * Read a streamed Responses body. The final `response.completed` event carries the whole response;
 * when its `output` is empty, the items from `response.output_item.done` fill it. A stream with no
 * terminal event is a drop.
 */
export async function readCodexStream(body: ReadableStream<Uint8Array> | null): Promise<{ response: Dict; raw: string }> {
  const items: Dict[] = [];
  const texts = new Map<string, string[]>();
  let final: Dict | null = null;
  const raw: string[] = [];
  for await (const ev of guardedEvents(body, "Responses")) {
    if (ev.data.trim() === "[DONE]") break;
    raw.push(ev.data);
    let e: Dict;
    try {
      e = JSON.parse(ev.data);
    } catch {
      throw new StreamDroppedError(`Malformed provider streaming response: ${ev.data.slice(0, 300)}`);
    }
    const t = String(e.type ?? ev.event ?? "");
    if (t === "response.output_item.done" && isDict(e.item)) items.push(e.item);
    else if (t === "response.output_text.delta" && typeof e.delta === "string") {
      const k = String(e.item_id ?? "");
      texts.set(k, [...(texts.get(k) ?? []), e.delta]);
    } else if (t === "response.completed" || t === "response.incomplete" || t === "response.failed") {
      final = isDict(e.response) ? e.response : {};
      if (t === "response.failed" && !final.status) final.status = "failed";
      if (t === "response.incomplete" && !final.status) final.status = "incomplete";
    } else if (t === "error") {
      throw new StreamDroppedError(`Responses stream error: ${String(e.message ?? e.error?.message ?? "unknown")}`);
    }
  }
  if (!final) throw new StreamDroppedError("Responses stream ended before response.completed (possible upstream stream drop).");
  if (!Array.isArray(final.output) || final.output.length === 0) final.output = items;
  return { response: final, raw: raw.join("\n") };
}
