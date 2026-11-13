import { hostMatches, hostOf } from "./chat.ts";
import { callerOwnsCache, capCacheBreakpoints, planPromptCache } from "./prompt-caching.ts";
import { StreamDroppedError, guardedEvents } from "./sse.ts";
import { type Dict, type Message, type ModelCallInput, type NormalizedResponse, type ToolCallWire, type ToolDefinition, type Usage, asList, clone, isDict, truthy } from "./types.ts";

/**
 * The anthropic_messages mode.
 *
 * Upstream files:
 * - `agent/anthropic_message_convert.py`: messages and tools to the Messages API.
 * - `agent/anthropic_adapter.py`: `build_anthropic_kwargs`, thinking, betas, stream.
 * - `agent/anthropic_thinking_policy.py`, `agent/anthropic_endpoints.py`: which routes replay thinking.
 * - `agent/transports/anthropic.py`: `normalize_response`.
 *
 * Not ported (see NOTES.md): the OAuth "Claude Code" identity rewrite, image
 * eviction, the Bedrock/Vertex SDK clients, `fast_mode`.
 */

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);
const CACHEABLE_TYPES = new Set(["text", "tool_use"]);
const EMPTY_TEXT_PLACEHOLDER = "(empty)";
const BEDROCK_REGION_PREFIXES = ["global.", "us.", "eu.", "apac.", "ap.", "au.", "jp.", "ca.", "sa.", "me.", "af."];

// ---------------------------------------------------------------- small block helpers

const blockType = (b: unknown): unknown => (isDict(b) ? b.type : null);
const hasBlockType = (blocks: unknown[], types: Set<string>): boolean => blocks.some((b) => types.has(blockType(b) as string));
const textBlock = (text: string): Dict => ({ type: "text", text });
const isBlankTextBlock = (b: unknown): boolean => blockType(b) === "text" && !(typeof (b as Dict).text === "string" && (b as Dict).text.trim());
const cacheControlOf = (b: unknown): Dict | null => (isDict(b) && isDict(b.cache_control) ? b.cache_control : null);

function textBlockWithCitations(text: unknown, cits: unknown): Dict {
  const block = textBlock(text as string);
  if (Array.isArray(cits) && cits.length > 0) block.citations = cits;
  return block;
}

function carryCacheControl(out: Dict, b: unknown, copy = false): Dict {
  const cc = cacheControlOf(b);
  if (cc) out.cache_control = copy ? { ...cc } : cc;
  return out;
}

function parseToolArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const stripThinking = (blocks: unknown[]): unknown[] => blocks.filter((b) => !THINKING_TYPES.has(blockType(b) as string));
const blockIds = (blocks: unknown[], type: string, key: string): Set<unknown> => new Set(blocks.filter((b) => blockType(b) === type).map((b) => (b as Dict)[key]));

function sanitizeToolId(id: unknown): string {
  const s = typeof id === "string" ? id : "";
  return (s ? s.replace(/[^a-zA-Z0-9_-]/g, "_") : "") || "tool_0";
}

const toolUseBlock = (id: unknown, name: unknown, input: unknown): Dict => ({ type: "tool_use", id: sanitizeToolId(id), name, input });

// ---------------------------------------------------------------- model names

/** `anthropic_message_convert.py:_is_bedrock_model_id` */
function isBedrockModelId(model: string): boolean {
  const m = model.toLowerCase();
  return [...BEDROCK_REGION_PREFIXES, "anthropic."].some((p) => m.startsWith(p));
}

/** `anthropic_message_convert.py:normalize_model_name`: strip `anthropic/`, and dots to hyphens for Claude ids. */
export function normalizeModelName(model: string, preserveDots = false): string {
  if (model.toLowerCase().startsWith("anthropic/")) model = model.slice("anthropic/".length);
  if (!preserveDots && !isBedrockModelId(model) && model.toLowerCase().startsWith("claude-")) model = model.replaceAll(".", "-");
  return model;
}

// ---------------------------------------------------------------- tools

const UNION_KEYS = ["anyOf", "oneOf"];
const UNION_META_KEYS = ["description", "title", "default"];

function rewrite(node: unknown, fn: (d: Dict) => unknown): unknown {
  if (Array.isArray(node)) return node.map((n) => rewrite(n, fn));
  if (!isDict(node)) return node;
  const out: Dict = {};
  for (const [k, v] of Object.entries(node)) out[k] = rewrite(v, fn);
  return fn(out);
}

/** `tools/schema_sanitizer.py:strip_nullable_unions` with `keep_nullable_hint=False`. */
export function stripNullableUnions(schema: unknown): unknown {
  const collapse = (stripped: Dict): unknown => {
    for (const key of UNION_KEYS) {
      const variants = stripped[key];
      if (!Array.isArray(variants)) continue;
      const nonNull = variants.filter((i) => !(isDict(i) && i.type === "null"));
      if (nonNull.length === 1 && nonNull.length !== variants.length) {
        const replacement: Dict = isDict(nonNull[0]) ? { ...nonNull[0] } : {};
        for (const m of UNION_META_KEYS) {
          if (m in stripped && !(m in replacement) && !(m === "default" && "$ref" in replacement)) replacement[m] = stripped[m];
        }
        return rewrite(replacement, collapse);
      }
    }
    return stripped;
  };
  return rewrite(schema, collapse);
}

/** `_normalize_tool_input_schema` */
function normalizeToolInputSchema(schema: unknown): Dict {
  let normalized = truthy(schema) ? stripNullableUnions(schema) : null;
  if (!isDict(normalized)) return { type: "object", properties: {} };
  const banned = ["oneOf", "allOf", "anyOf"];
  if (banned.some((b) => b in (normalized as Dict))) {
    normalized = Object.fromEntries(Object.entries(normalized as Dict).filter(([k]) => !banned.includes(k)));
    (normalized as Dict).type ??= "object";
  }
  if ((normalized as Dict).type === "object" && !isDict((normalized as Dict).properties)) normalized = { ...(normalized as Dict), properties: {} };
  return normalized as Dict;
}

/** `convert_tools_to_anthropic`: duplicates dropped, `cache_control` forwarded. */
export function convertToolsToAnthropic(tools: ToolDefinition[]): Dict[] {
  const result: Dict[] = [];
  const seen = new Set<string>();
  for (const t of tools ?? []) {
    const fn = (t.function ?? {}) as Dict;
    const name = fn.name ?? "";
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    const tool: Dict = { name, description: fn.description ?? "", input_schema: normalizeToolInputSchema(fn.parameters ?? {}) };
    result.push(carryCacheControl(tool, t, true));
  }
  return result;
}

// ---------------------------------------------------------------- content

function imageBlockFromUrl(url: string): Dict {
  url = String(url ?? "").trim();
  if (!url.startsWith("data:")) return { type: "image", source: { type: "url", url } };
  const comma = url.indexOf(",");
  const header = comma < 0 ? url : url.slice(0, comma);
  const data = comma < 0 ? "" : url.slice(comma + 1);
  const mime = header.slice("data:".length).split(";")[0]!.trim();
  let mediaType = mime.startsWith("image/") ? mime : "image/jpeg";
  if (mediaType.toLowerCase() === "image/jpg") mediaType = "image/jpeg";
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

function convertContentPart(part: unknown): Dict | null {
  if (part === null || part === undefined) return null;
  if (!isDict(part)) return textBlock(typeof part === "string" ? part : String(part));
  const ptype = part.type;
  let block: Dict;
  if (ptype === "input_text" || ptype === "text") {
    block = textBlockWithCitations(part.text ?? "", ptype === "text" ? part.citations : null);
  } else if (ptype === "image_url" || ptype === "input_image") {
    const v = part.image_url ?? {};
    block = imageBlockFromUrl(isDict(v) ? (v.url ?? "") : String(v ?? ""));
  } else {
    block = { ...part };
  }
  const cc = cacheControlOf(part);
  if (cc && !("cache_control" in block)) block.cache_control = { ...cc };
  return block;
}

function convertContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(convertContentPart).filter((b): b is Dict => b !== null);
}

function contentPartsToToolResultBlocks(parts: unknown): Dict[] {
  const out: Dict[] = [];
  for (const block of asList(parts).map(convertContentPart)) {
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) out.push(textBlock(block.text));
    else if (block.type === "image" && isDict(block.source) && Object.keys(block.source).length > 0) out.push({ type: "image", source: block.source });
  }
  return out;
}

// ---------------------------------------------------------------- thinking replay

/** `anthropic_message_convert.py:_sanitize_replay_block`: whitelist a stored block so it is valid as request input. */
function sanitizeReplayBlock(b: unknown): Dict | null {
  if (!isDict(b)) return null;
  switch (b.type) {
    case "text":
      return isBlankTextBlock(b) ? null : carryCacheControl(textBlockWithCitations(b.text, b.citations), b);
    case "thinking": {
      const out: Dict = { type: "thinking", thinking: b.thinking ?? "" };
      return b.signature ? { ...out, signature: b.signature } : out;
    }
    case "redacted_thinking":
      return b.data ? { type: "redacted_thinking", data: b.data } : null;
    case "tool_use":
      return carryCacheControl(toolUseBlock(b.id ?? "", b.name ?? "", b.input ?? {}), b);
    case "image":
      return isDict(b.source) ? { type: "image", source: b.source } : null;
    default:
      return null;
  }
}

function applyCacheToLastCacheable(blocks: Dict[], cc: unknown): void {
  if (!isDict(cc)) return;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (CACHEABLE_TYPES.has(blocks[i]!.type)) {
      blocks[i]!.cache_control ??= { ...cc };
      return;
    }
  }
}

/** `_replay_ordered_blocks`: rebuild an interleaved thinking turn from the stored block list. */
function replayOrderedBlocks(m: Message, ordered: unknown[]): Dict[] | null {
  const redactedInput = new Map<string, unknown>();
  for (const tc of asList(m.tool_calls)) {
    if (isDict(tc)) redactedInput.set(sanitizeToolId(tc.id ?? ""), parseToolArgs((tc.function ?? {}).arguments ?? "{}"));
  }
  const replayed: Dict[] = [];
  let relocated: Dict | null = null;
  let droppedBlankText = false;
  for (const b of ordered) {
    const clean = sanitizeReplayBlock(b);
    if (clean === null) {
      droppedBlankText = droppedBlankText || blockType(b) === "text";
      const cc = cacheControlOf(b);
      if (cc) relocated = cc;
      continue;
    }
    if (clean.type === "tool_use" && redactedInput.has(clean.id)) clean.input = redactedInput.get(clean.id);
    replayed.push(clean);
  }
  if (!hasBlockType(replayed, CACHEABLE_TYPES) && (droppedBlankText || relocated !== null)) replayed.push(textBlock(EMPTY_TEXT_PLACEHOLDER));
  if (replayed.length === 0) return null;
  applyCacheToLastCacheable(replayed, relocated);
  applyCacheToLastCacheable(replayed, m.cache_control);
  if (Array.isArray(m.content)) {
    const inline = m.content.map(cacheControlOf).find((c) => c !== null) ?? null;
    applyCacheToLastCacheable(replayed, inline);
  }
  return replayed;
}

/** `bedrock_adapter.py:reasoning_minted_outside_claude`, reduced: a stamped non-Claude issuer. */
function reasoningMintedOutsideClaude(msg: Message): boolean {
  const issuer = asList(msg.reasoning_details).find((d) => isDict(d) && d.type === "bedrock.native_assistant" && typeof d.model === "string") as Dict | undefined;
  return issuer !== undefined && !String(issuer.model).toLowerCase().includes("claude");
}

function extractPreservedThinkingBlocks(m: Message): Dict[] {
  if (!Array.isArray(m.reasoning_details)) return [];
  if (reasoningMintedOutsideClaude(m)) return [];
  return m.reasoning_details.filter((d) => isDict(d) && THINKING_TYPES.has(String(d.type ?? "").trim().toLowerCase())).map((d) => clone(d as Dict));
}

/** `assistant_replay_carrier`: the ordered sidecar when any block survives it, else the `reasoning_details` blocks. */
function assistantReplayCarrier(m: Message): [boolean, Dict[]] {
  const ordered = m.anthropic_content_blocks;
  if (Array.isArray(ordered) && ordered.length > 0) {
    const replayed = replayOrderedBlocks(m, ordered);
    if (replayed && replayed.length > 0) return [true, replayed];
  }
  return [false, extractPreservedThinkingBlocks(m)];
}

function splitBlankTextBlocks(blocks: unknown[]): [unknown[], Dict | null] {
  const dropped = blocks.map((b, i) => (isBlankTextBlock(b) ? i : -1)).filter((i) => i >= 0);
  const kept = blocks.filter((_b, i) => !dropped.includes(i));
  const relocated = dropped.map((i) => cacheControlOf(blocks[i])).filter((c): c is Dict => c !== null);
  return [kept, relocated.length > 0 ? relocated[relocated.length - 1]! : null];
}

function convertAssistantMessage(m: Message): Dict {
  const content = m.content ?? "";
  const [ordered, blocks] = assistantReplayCarrier(m);
  if (ordered) return { role: "assistant", content: blocks };
  let relocated: Dict | null = null;
  if (Array.isArray(content)) {
    const [kept, rel] = splitBlankTextBlocks(convertContent(content) as unknown[]);
    relocated = rel;
    blocks.push(...(kept as Dict[]));
  } else if (truthy(content) && String(content).trim()) {
    blocks.push(textBlock(String(content)));
  }
  for (const tc of asList(m.tool_calls)) {
    if (!isDict(tc)) continue;
    const fn = tc.function ?? {};
    blocks.push(toolUseBlock(tc.id ?? "", fn.name ?? "", parseToolArgs(fn.arguments ?? "{}")));
  }
  // Kimi's /coding endpoint needs `reasoning_content` on replayed tool-call turns, even "".
  if (typeof m.reasoning_content === "string" && !hasBlockType(blocks, THINKING_TYPES)) blocks.unshift({ type: "thinking", thinking: m.reasoning_content });
  const effective = blocks.length > 0 ? blocks : [textBlock(EMPTY_TEXT_PLACEHOLDER)];
  applyCacheToLastCacheable(effective, relocated);
  applyCacheToLastCacheable(effective, m.cache_control);
  return { role: "assistant", content: effective };
}

function toolResultContent(m: Message): unknown {
  const content = m.content ?? "";
  let multimodal: Dict[] | null = null;
  if (isDict(content) && content._multimodal) {
    multimodal = contentPartsToToolResultBlocks(content.content ?? []);
    if (multimodal.length === 0 && content.text_summary) multimodal = [textBlock(String(content.text_summary))];
  } else if (Array.isArray(content)) {
    const converted = contentPartsToToolResultBlocks(content);
    if (hasBlockType(converted, new Set(["image"]))) multimodal = converted;
  }
  if (multimodal === null) {
    const stashed = m._anthropic_content_blocks;
    if (Array.isArray(stashed) && stashed.length > 0) {
      const text = typeof content === "string" && content.trim() ? content : null;
      multimodal = text ? [textBlock(text), ...stashed] : [...stashed];
    }
  }
  if (multimodal && multimodal.length > 0) return multimodal;
  const s = typeof content === "string" ? content : truthy(content) ? JSON.stringify(content) : "";
  return s || "(no output)";
}

function convertToolMessageToResult(result: Dict[], m: Message): void {
  const toolResult: Dict = { type: "tool_result", tool_use_id: sanitizeToolId(m.tool_call_id ?? ""), content: toolResultContent(m) };
  carryCacheControl(toolResult, m, true);
  const last = result[result.length - 1];
  const lastContent = last && last.role === "user" ? last.content : null;
  if (Array.isArray(lastContent) && lastContent.length > 0 && lastContent[0].type === "tool_result") lastContent.push(toolResult);
  else result.push({ role: "user", content: [toolResult] });
}

function fixBlankTextBlocks(blocks: unknown[], placeholder: string): unknown[] {
  const [kept0, relocated] = splitBlankTextBlocks(blocks);
  const kept = (kept0.length > 0 ? kept0 : [textBlock(placeholder)]) as Dict[];
  applyCacheToLastCacheable(kept, relocated);
  return kept;
}

function convertUserMessage(content: unknown): Dict {
  if (Array.isArray(content)) content = fixBlankTextBlocks(convertContent(content) as unknown[], "(empty message)");
  else if (!truthy(content) || (typeof content === "string" && !content.trim())) content = "(empty message)";
  return { role: "user", content };
}

const assistantBlockLists = (result: Dict[]): Array<[number, Dict]> => result.map((m, i): [number, Dict] => [i, m]).filter(([, m]) => m.role === "assistant" && Array.isArray(m.content));

/** `_strip_orphaned_tool_blocks`: a tool_use needs its tool_result in the very next user message, and the reverse. */
function stripOrphanedToolBlocks(result: Dict[]): void {
  for (const [i, m] of assistantBlockLists(result)) {
    const ids = blockIds(m.content, "tool_use", "id");
    if (ids.size === 0) continue;
    let adjacent = new Set<unknown>();
    const next = result[i + 1];
    if (next && next.role === "user" && Array.isArray(next.content)) adjacent = blockIds(next.content, "tool_result", "tool_use_id");
    const orphaned = new Set([...ids].filter((x) => !adjacent.has(x)));
    if (orphaned.size === 0) continue;
    const kept = m.content.filter((b: Dict) => !(blockType(b) === "tool_use" && orphaned.has(b.id)));
    if (kept.length !== m.content.length && hasBlockType(m.content, THINKING_TYPES)) m._thinking_signature_invalidated = true;
    m.content = kept.length > 0 ? kept : [textBlock("(tool call removed)")];
  }
  const surviving = new Set<unknown>();
  for (const [, m] of assistantBlockLists(result)) for (const id of blockIds(m.content, "tool_use", "id")) surviving.add(id);
  for (const m of result) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const next = m.content.filter((b: Dict) => blockType(b) !== "tool_result" || surviving.has(b.tool_use_id));
    if (next.length !== m.content.length) m.content = next.length > 0 ? next : [textBlock("(tool result removed)")];
  }
}

function concatContent(prev: unknown, curr: unknown): unknown[] {
  const asBlocks = (c: unknown): unknown[] => (typeof c === "string" ? [textBlock(c)] : [...(c as unknown[])]);
  return [...asBlocks(prev), ...asBlocks(curr)];
}

/** `_merge_consecutive_roles`. Strings are never joined: each side stays its own block. */
function mergeConsecutiveRoles(result: Dict[]): Dict[] {
  const fixed: Dict[] = [];
  for (const m of result) {
    const last = fixed[fixed.length - 1];
    if (!last || last.role !== m.role) {
      fixed.push(m);
      continue;
    }
    if (m.role !== "user") {
      if (m._thinking_signature_invalidated) last._thinking_signature_invalidated = true;
      if (Array.isArray(m.content)) m.content = stripThinking(m.content);
    }
    last.content = concatContent(last.content, m.content);
  }
  return fixed;
}

function keepValidThinking(content: unknown[], signatureDead: boolean): unknown[] {
  const out: unknown[] = [];
  for (const b of content) {
    if (!THINKING_TYPES.has(blockType(b) as string)) {
      out.push(b);
      continue;
    }
    const blk = b as Dict;
    const redacted = blk.type === "redacted_thinking";
    const signed = redacted ? blk.data : blk.signature;
    if (signed && !signatureDead) out.push(b);
    else if ((signatureDead || !redacted) && blk.thinking) out.push(textBlock(blk.thinking));
  }
  return out;
}

function currentToolLoopStart(result: Dict[]): number {
  for (let i = result.length - 1; i >= 0; i--) {
    const m = result[i]!;
    if (m.role !== "user") continue;
    if (!(Array.isArray(m.content) && m.content.some((b: unknown) => blockType(b) === "tool_result"))) return i + 1;
  }
  return 0;
}

// ---------------------------------------------------------------- thinking routes

const KIMI_PREFIXES = ["kimi-", "kimi_", "moonshot-", "moonshot_", "k1.", "k1-", "k2.", "k2-", "k25", "k2.5", "k3.", "k3-"];
const DEEPSEEK_THINKING_PREFIXES = ["deepseek-r", "deepseek-v4", "deepseek_v4", "deepseek-pro", "deepseek_pro", "deepseek-flash", "deepseek_flash"];
const MINIMAX_PREFIXES = ["https://api.minimax.io/anthropic", "https://api.minimaxi.com/anthropic"];

const normLower = (u: string | null | undefined): string => (u ? String(u).trim().replace(/\/+$/, "").toLowerCase() : "");
const isThirdParty = (u: string | null | undefined): boolean => normLower(u) !== "" && !normLower(u).includes("anthropic.com");
const isKimiModel = (model: string | null | undefined): boolean => {
  if (typeof model !== "string") return false;
  const m = model.trim().toLowerCase().split("/").pop() ?? "";
  return m !== "" && (m === "k3" || KIMI_PREFIXES.some((p) => m.startsWith(p)));
};
const isKimiEndpoint = (u: string | null | undefined, model?: string | null): boolean => {
  const h = hostOf(u);
  return normLower(u).startsWith("https://api.kimi.com/coding") || ["api.kimi.com", "moonshot.ai", "moonshot.cn"].some((d) => hostMatches(h, d)) || isKimiModel(model);
};
const isNousPortal = (u: string | null | undefined): boolean => hostOf(u) === "inference-api.nousresearch.com";
const isMinimax = (u: string | null | undefined): boolean => MINIMAX_PREFIXES.some((p) => normLower(u).startsWith(p));
const isDeepseekEndpoint = (u: string | null | undefined): boolean => hostOf(u) === "api.deepseek.com" && normLower(u).includes("/anthropic");
const deepseekThinkingModel = (model: string | null | undefined): boolean => {
  if (typeof model !== "string") return false;
  const name = model.trim().toLowerCase().split("/").pop() ?? "";
  return name !== "" && DEEPSEEK_THINKING_PREFIXES.some((p) => name.startsWith(p));
};
function isClaudePlatform(u: string | null | undefined): boolean {
  const h = hostOf(u);
  const bedrock = h.split(".").some((l) => l.startsWith("bedrock-runtime")) && (hostMatches(h, "amazonaws.com") || hostMatches(h, "amazonaws.com.cn"));
  const vertex = h === "aiplatform.googleapis.com" || h.endsWith("-aiplatform.googleapis.com");
  const azure = `.${h}.`.includes(".services.ai.azure.") || `.${h}.`.includes(".openai.azure.");
  return bedrock || vertex || (azure && normLower(u).includes("/anthropic"));
}
const isOffAnthropic = (u: string | null | undefined): boolean => isThirdParty(u) && !isNousPortal(u);

/** `anthropic_thinking_policy.py:anthropic_thinking_route`. First match wins. */
export function thinkingRoute(baseUrl: string | null | undefined, model: string | null | undefined): "kimi" | "deepseek" | "native" | "minimax" | "third_party" {
  if (isKimiEndpoint(baseUrl, model)) return "kimi";
  if (isDeepseekEndpoint(baseUrl) || (isOffAnthropic(baseUrl) && deepseekThinkingModel(model))) return "deepseek";
  if (!isOffAnthropic(baseUrl) || isClaudePlatform(baseUrl)) return "native";
  if (isMinimax(baseUrl)) return "minimax";
  return "third_party";
}

const CLAUDE_VERSION_RE = /claude[-_.](opus|sonnet|haiku|fable|mythos)[-_.](\d+)(?:[-_.](\d{1,2})(?=$|[-_.]))?/i;
const LAST_TURN_ONLY_RE = /claude[-_.]?3(?!\d)/i;
const KEEP_ALL_FROM: Record<string, [number, number]> = { opus: [4, 5], sonnet: [4, 6], haiku: [5, 5] };

/** `model_preserves_prior_thinking` */
export function modelPreservesPriorThinking(model: unknown): boolean {
  if (typeof model !== "string" || !model.toLowerCase().includes("claude") || LAST_TURN_ONLY_RE.test(model)) return false;
  const m = CLAUDE_VERSION_RE.exec(model.trim());
  if (!m) return true;
  const family = m[1]!.toLowerCase();
  const [fmaj, fmin] = KEEP_ALL_FROM[family] ?? [5, 0];
  const major = Number(m[2]);
  const minor = Number(m[3] ?? 0);
  return major > fmaj || (major === fmaj && minor >= fmin);
}

/** `_manage_thinking_signatures`: strip or keep thinking blocks per route. */
function manageThinkingSignatures(result: Dict[], baseUrl: string | null | undefined, model: string | null | undefined): void {
  const route = thinkingRoute(baseUrl, model);
  let lastAssistant = result.length;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const loopStart = Math.min(currentToolLoopStart(result), lastAssistant);
  const preservePrior = route === "minimax" || (route === "native" && modelPreservesPriorThinking(model));
  for (const [idx, m] of assistantBlockLists(result)) {
    if (route === "kimi") {
      // replay as is
    } else if (route === "deepseek") {
      const next = m.content.filter((b: Dict) => !THINKING_TYPES.has(blockType(b) as string) || !(b.signature || b.data));
      m.content = next.length > 0 ? next : [textBlock("(empty)")];
    } else if (route === "third_party" || (idx < loopStart && !preservePrior)) {
      const next = stripThinking(m.content);
      m.content = next.length > 0 ? next : [textBlock("(thinking elided)")];
    } else {
      const next = keepValidThinking(m.content, Boolean(m._thinking_signature_invalidated));
      m.content = next.length > 0 ? next : [textBlock("(empty)")];
    }
    for (const b of m.content) if (THINKING_TYPES.has(blockType(b) as string)) delete (b as Dict).cache_control;
    delete m._thinking_signature_invalidated;
  }
}

function ensureLeadingUserTurn(result: Dict[]): void {
  if (result.length > 0 && result[0]!.role !== "user") result.unshift({ role: "user", content: [textBlock(EMPTY_TEXT_PLACEHOLDER)] });
}

/** `_scrub_blank_text_blocks`: the last guard against blank text blocks, also inside tool_result content. */
function scrubBlankTextBlocks(result: Dict[]): void {
  for (const msg of result) {
    const content = msg.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    msg.content = fixBlankTextBlocks(content, msg.role === "assistant" ? EMPTY_TEXT_PLACEHOLDER : "(empty message)");
    for (const blk of msg.content as Dict[]) {
      const inner = blockType(blk) === "tool_result" ? blk.content : null;
      if (Array.isArray(inner) && inner.length > 0) blk.content = fixBlankTextBlocks(inner, "(no output)");
    }
  }
}

function convertSystemContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  if (!content.some((p) => isDict(p) && p.cache_control)) return content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  return content.filter(isDict).map((p) => (isBlankTextBlock(p) && typeof p.text === "string" ? { ...p, text: EMPTY_TEXT_PLACEHOLDER } : p));
}

/** `convert_messages_to_anthropic`: returns `[system, messages]`. */
export function convertMessagesToAnthropic(messages: Message[], baseUrl?: string | null, model?: string | null): [unknown, Dict[]] {
  let system: unknown = null;
  let result: Dict[] = [];
  // Work on copies: the steps below change blocks in place.
  for (const m0 of messages) {
    const m = m0;
    const role = m.role ?? "user";
    if (role === "system") system = convertSystemContent(m.content ?? "");
    else if (role === "assistant") result.push(convertAssistantMessage(m));
    else if (role === "tool") convertToolMessageToResult(result, m);
    else result.push(convertUserMessage(m.content ?? ""));
  }
  stripOrphanedToolBlocks(result);
  result = mergeConsecutiveRoles(result);
  ensureLeadingUserTurn(result);
  manageThinkingSignatures(result, baseUrl, model);
  scrubBlankTextBlocks(result);
  return [system, result];
}

// ---------------------------------------------------------------- request

const THINKING_BUDGET: Record<string, number> = { xhigh: 32000, high: 16000, medium: 8000, low: 4000 };
const ADAPTIVE_EFFORT: Record<string, string> = { ultra: "max", max: "max", xhigh: "xhigh", high: "high", medium: "medium", low: "low", minimal: "low" };
const LEGACY_MANUAL = ["claude-3", "claude-opus-4-0", "claude-opus-4.0", "claude-opus-4-1", "claude-opus-4.1", "claude-sonnet-4-0", "claude-sonnet-4.0", "claude-opus-4-2025", "claude-sonnet-4-2025", "claude-opus-4-5", "claude-opus-4.5", "claude-sonnet-4-5", "claude-sonnet-4.5", "claude-haiku-4-5", "claude-haiku-4.5"];
const NO_XHIGH = ["claude-opus-4-6", "claude-opus-4.6", "claude-sonnet-4-6", "claude-sonnet-4.6"];
const MANDATORY_THINKING = ["claude-fable", "claude-mythos", "claude-opus-5-5", "claude-opus-5.5"];
const BETWEEN_TOOLS_OFF = ["claude-sonnet-5-5", "claude-sonnet-5.5"];
const OUTPUT_LIMITS: Record<string, number> = {
  "claude-fable": 128000, "claude-sonnet-5": 128000, "claude-opus-4-8": 128000, "claude-opus-4-7": 128000, "claude-opus-4-6": 128000,
  "claude-sonnet-4-6": 64000, "claude-opus-4-5": 64000, "claude-sonnet-4-5": 64000, "claude-haiku-4-5": 64000, "claude-opus-4": 32000,
  "claude-sonnet-4": 64000, "claude-3-7-sonnet": 128000, "claude-3-5-sonnet": 8192, "claude-3-5-haiku": 8192, "claude-3-opus": 4096,
  "claude-3-sonnet": 4096, "claude-3-haiku": 4096, minimax: 131072, qwen3: 65536,
};
const DEFAULT_OUTPUT_LIMIT = 128000;
const TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const COMMON_BETAS = ["interleaved-thinking-2025-05-14", TOOL_STREAMING_BETA];
const CONTEXT_1M_BETA = "context-1m-2025-08-07";

const isClaude = (m: string): boolean => m.toLowerCase().includes("claude");
const matches = (m: string, subs: string[]): boolean => subs.some((s) => m.toLowerCase().includes(s));

function maxOutput(model: string): number {
  const m = model.toLowerCase().replaceAll(".", "-");
  const keys = Object.keys(OUTPUT_LIMITS).filter((k) => m.includes(k));
  if (keys.length === 0) return DEFAULT_OUTPUT_LIMIT;
  return OUTPUT_LIMITS[keys.reduce((a, b) => (b.length > a.length ? b : a))]!;
}

export const supportsAdaptiveThinking = (model: string): boolean => isKimiModel(model) || (isClaude(model) && !matches(model, LEGACY_MANUAL));
const supportsXhigh = (model: string): boolean => supportsAdaptiveThinking(model) && !matches(model, NO_XHIGH);
const acceptsThinkingDisable = (model: string): boolean => isClaude(model) && supportsAdaptiveThinking(model) && !matches(model, [...MANDATORY_THINKING, ...BETWEEN_TOOLS_OFF]);
function isPreThinkingHaiku(model: string): boolean {
  if (!model.toLowerCase().includes("haiku")) return false;
  const m = CLAUDE_VERSION_RE.exec(model.trim());
  if (!m || m[1]!.toLowerCase() !== "haiku") return true;
  const major = Number(m[2]);
  const minor = Number(m[3] ?? 0);
  return !(major > 5 || (major === 5 && minor >= 5));
}
export const forbidsSamplingParams = (model: string): boolean => isClaude(model) && !matches(model, [...NO_XHIGH, ...LEGACY_MANUAL]);

/** `anthropic_adapter.py:_thinking_kwargs` */
export function thinkingKwargs(rc: { effort?: string; enabled?: boolean }, model: string, effectiveMaxTokens: number): Dict {
  if (rc.enabled === false) {
    if (matches(model, BETWEEN_TOOLS_OFF)) return { thinking: { type: "between_tools" } };
    return acceptsThinkingDisable(model) ? { thinking: { type: "disabled" } } : {};
  }
  if (isPreThinkingHaiku(model)) return {};
  const effort = String(rc.effort ?? "medium").toLowerCase();
  if (supportsAdaptiveThinking(model)) {
    let adaptive = ADAPTIVE_EFFORT[effort] ?? "medium";
    if (adaptive === "xhigh" && !supportsXhigh(model)) adaptive = "max";
    return { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: adaptive } };
  }
  const budget = THINKING_BUDGET[effort] ?? 8000;
  return { thinking: { type: "enabled", budget_tokens: budget }, temperature: 1, max_tokens: Math.max(effectiveMaxTokens, budget + 4096) };
}

function resolvePositiveMaxTokens(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  return n > 0 ? n : null;
}

/** The Anthropic betas safe for a base URL. `_common_betas_for_base_url`. */
export function commonBetas(baseUrl?: string | null): string[] {
  const betas = [...COMMON_BETAS];
  if (normLower(baseUrl).includes("azure.com")) betas.push(CONTEXT_1M_BETA);
  return isMinimax(baseUrl) ? betas.filter((b) => b !== TOOL_STREAMING_BETA && b !== CONTEXT_1M_BETA) : betas;
}

const TOOL_CHOICE_MAP: Record<string, Dict> = { auto: { type: "auto" }, required: { type: "any" } };

/**
 * `build_anthropic_kwargs`. The body keys keep upstream's order:
 * model, messages, max_tokens, system, tools, tool_choice, then the thinking
 * fields. `stream: true` is added last for a streamed call.
 */
export function buildAnthropicBody(input: ModelCallInput): string {
  const o = input.options ?? {};
  const planned = planPromptCache(input.messages, input.tools, { mode: "anthropic_messages", model: input.model, baseUrl: o.baseUrl, promptCaching: callerOwnsCache(o.extraBody) ? false : o.promptCaching, staticSystemPrefix: o.staticSystemPrefix });
  const [system, msgs] = convertMessagesToAnthropic(clone(planned.messages), o.baseUrl, input.model);
  const tools = planned.tools.length > 0 ? convertToolsToAnthropic(planned.tools) : [];
  const model = isNousPortal(o.baseUrl) ? input.model : normalizeModelName(input.model);
  const effective = resolvePositiveMaxTokens(o.maxTokens) ?? maxOutput(model);
  const kwargs: Dict = { model, messages: msgs, max_tokens: effective };
  if (truthy(system)) kwargs.system = system;
  if (tools.length > 0) {
    kwargs.tools = tools;
    const tc = o.toolChoice ?? null;
    if (tc === "none") delete kwargs.tools;
    else kwargs.tool_choice = TOOL_CHOICE_MAP[tc ?? "auto"] ?? { type: "tool", name: tc };
  }
  if (o.reasoningConfig) Object.assign(kwargs, thinkingKwargs(o.reasoningConfig, model, effective));
  if (forbidsSamplingParams(model)) for (const k of ["temperature", "top_p", "top_k"]) delete kwargs[k];
  if (o.extraBody) Object.assign(kwargs, clone(o.extraBody)); // a copy: the cap below may change it
  if (planned.cached) capCacheBreakpoints(kwargs);
  if (o.stream) kwargs.stream = true;
  return JSON.stringify(kwargs);
}

/** Headers of a Messages call. Third-party endpoints that use bearer auth get `authorization`. */
export function anthropicHeaders(apiKey: string | undefined, baseUrl?: string | null): Record<string, string> {
  const norm = normLower(baseUrl);
  const bearer = isNousPortal(baseUrl) || isMinimax(baseUrl) || norm.includes("azure.com") || hostMatches(hostOf(baseUrl), "palantirfoundry.com") || hostMatches(hostOf(baseUrl), "api.commandcode.ai");
  const h: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (apiKey) {
    if (bearer) h.authorization = `Bearer ${apiKey}`;
    else h["x-api-key"] = apiKey;
  }
  const betas = commonBetas(baseUrl);
  if (betas.length > 0) h["anthropic-beta"] = betas.join(",");
  return h;
}

// ---------------------------------------------------------------- response

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop", tool_use: "tool_calls", max_tokens: "length", stop_sequence: "stop", refusal: "content_filter", model_context_window_exceeded: "length",
};

function anthropicUsage(u: unknown): Usage {
  const o = isDict(u) ? u : {};
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const cached = n(o.cache_read_input_tokens);
  // `input_tokens` excludes cached tokens; add them back like the Bedrock adapter does.
  return { promptTokens: n(o.input_tokens) + cached + n(o.cache_creation_input_tokens), completionTokens: n(o.output_tokens), cachedTokens: cached };
}

/**
 * `transports/anthropic.py:normalize_response`. Returns a string when the body is not a message.
 * Ordered blocks are kept only for a turn that mixes signed thinking with tool_use.
 */
export function parseAnthropicResponse(json: unknown): NormalizedResponse | string {
  if (!isDict(json) || !Array.isArray(json.content)) return "the model answer is not a message";
  if (json.content.length === 0 && !["end_turn", "refusal"].includes(String(json.stop_reason))) return "the model answer has no content";
  const text: string[] = [];
  const reasoning: string[] = [];
  const details: Dict[] = [];
  const calls: ToolCallWire[] = [];
  const ordered: Dict[] = [];
  for (const block of json.content) {
    if (!isDict(block)) continue;
    const clean = sanitizeReplayBlock(block);
    if (clean) ordered.push(clean);
    if (block.type === "text") text.push(block.text);
    else if (THINKING_TYPES.has(block.type)) {
      if (block.type === "thinking") reasoning.push(block.thinking);
      details.push(clean ?? clone(block));
    } else if (block.type === "tool_use") {
      calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    }
  }
  const providerData: Dict = {};
  if (details.length > 0) providerData.reasoning_details = details;
  if (json.stop_details !== undefined && json.stop_details !== null) providerData.stop_details = json.stop_details;
  const signed = ordered.some((b) => THINKING_TYPES.has(b.type) && (b.signature || b.data));
  if (signed && ordered.some((b) => b.type === "tool_use")) providerData.anthropic_content_blocks = ordered;
  return {
    content: text.length > 0 ? text.join("\n") : null,
    toolCalls: calls,
    finishReason: STOP_REASON_MAP[String(json.stop_reason)] ?? "stop",
    reasoning: reasoning.length > 0 ? reasoning.join("\n\n") : null,
    usage: anthropicUsage(json.usage),
    providerData: Object.keys(providerData).length > 0 ? providerData : null,
  };
}

/**
 * Add the events of a streamed Messages answer into the final message.
 * The stream must end with `message_stop`; any other end is a drop.
 * Upstream: `anthropic_adapter.py:_stream_final_message` (the SDK builds the message).
 */
export async function readAnthropicStream(body: ReadableStream<Uint8Array> | null): Promise<{ response: Dict; raw: string }> {
  const message: Dict = { content: [], usage: {} };
  const partial = new Map<number, string>();
  let stopped = false;
  const raw: string[] = [];
  for await (const ev of guardedEvents(body, "Anthropic Messages")) {
    raw.push(ev.data);
    let e: Dict;
    try {
      e = JSON.parse(ev.data);
    } catch {
      throw new StreamDroppedError(`Malformed provider streaming response: ${ev.data.slice(0, 300)}`);
    }
    switch (e.type) {
      case "message_start":
        Object.assign(message, clone(e.message ?? {}));
        message.content = [];
        message.usage = { ...(e.message?.usage ?? {}) };
        break;
      case "content_block_start":
        message.content[e.index] = clone(e.content_block);
        if (e.content_block?.type === "tool_use") partial.set(e.index, "");
        break;
      case "content_block_delta": {
        const b = message.content[e.index];
        const d = e.delta ?? {};
        if (!b) break;
        if (d.type === "text_delta") b.text = (b.text ?? "") + d.text;
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature;
        else if (d.type === "input_json_delta") partial.set(e.index, (partial.get(e.index) ?? "") + d.partial_json);
        break;
      }
      case "content_block_stop": {
        const b = message.content[e.index];
        if (b?.type === "tool_use") {
          const j = partial.get(e.index) ?? "";
          b.input = j ? parseToolArgs(j) : (b.input ?? {});
        }
        break;
      }
      case "message_delta":
        if (e.delta?.stop_reason !== undefined) message.stop_reason = e.delta.stop_reason;
        if (e.delta?.stop_details !== undefined) message.stop_details = e.delta.stop_details;
        // `output_tokens` of the delta replaces the start value; other usage keys are merged.
        message.usage = { ...message.usage, ...(e.usage ?? {}) };
        break;
      case "message_stop":
        stopped = true;
        break;
      case "error":
        throw new StreamDroppedError(`Anthropic Messages stream error: ${String(e.error?.message ?? "unknown")}`);
      default:
        break; // ping
    }
  }
  if (!stopped) throw new StreamDroppedError("Anthropic Messages stream ended before message_stop (possible upstream stream drop).");
  return { response: message, raw: raw.join("\n") };
}
