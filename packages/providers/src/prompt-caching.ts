import { hostMatches, hostOf } from "./chat.ts";
import { type ApiMode, type Dict, type Message, clone, isDict } from "./types.ts";

/**
 * Anthropic prompt caching: where the `cache_control` breakpoints go.
 * Upstream: `agent/prompt_caching.py:apply_anthropic_cache_control` and
 * `agent/agent_runtime_helpers.py:anthropic_prompt_cache_policy`.
 *
 * Four breakpoints at most. With a static system prefix: the prefix, the end of
 * the system prompt, and the last 2 messages that can carry a marker. Without
 * one: the system prompt and the last 3. All markers share one TTL.
 *
 * The markers go on the OpenAI-shape messages before the wire conversion, as
 * upstream does; the anthropic_messages converter moves a top-level marker of a
 * tool message into its `tool_result` block. The stored rows never change.
 *
 * Not ported: skill-scaffold splits (`find_stable_prefix`, the port has no
 * registered scaffolds), the direct native tool-array marker (off upstream unless
 * a route measures it), MoA and LiteLLM routes.
 */

export type CacheTtl = "5m" | "1h";

export interface CachePlanOptions {
  ttl?: CacheTtl;
  /** Markers on inner content blocks (the Messages wire), not on the envelope (OpenAI-wire proxies). */
  native: boolean;
  /** The stable tier of the system prompt. Used only when the system prompt starts with it. */
  staticSystemPrefix?: string | null;
}

const ALIBABA_FAMILY_PROVIDERS = new Set(["opencode", "opencode-go", "opencode-zen", "alibaba"]);

/**
 * `anthropic_prompt_cache_policy`: returns `[shouldCache, nativeLayout]`. The port has no
 * provider name, so routes are told by base URL and model, as upstream does when the
 * provider is unknown.
 */
export function anthropicPromptCachePolicy(r: { mode: ApiMode; model: string; baseUrl?: string | null | undefined; provider?: string | null | undefined }): [boolean, boolean] {
  const model = (r.model ?? "").toLowerCase();
  const provider = (r.provider ?? "").toLowerCase();
  const host = hostOf(r.baseUrl);
  const isClaude = model.includes("claude");
  const isKimi = /(^|\/)(kimi[-_]|moonshot|k1[.-]|k2[.-]|k25|k3[.-])/.test(model) || model.includes("moonshot");
  const isOpenRouter = hostMatches(host, "openrouter.ai");
  const isNousPortal = hostMatches(host, "nousresearch.com");
  const anthropicWire = r.mode === "anthropic_messages";
  const minimax = provider === "minimax" || provider === "minimax-cn" || hostMatches(host, "api.minimax.io") || hostMatches(host, "api.minimaxi.com");
  if (anthropicWire && minimax && /minimax-?m3/.test(model)) return [false, false];
  const nativeAnthropic = anthropicWire && (provider === "anthropic" || host === "api.anthropic.com" || (!r.baseUrl && !provider));
  if (nativeAnthropic) return [true, true];
  if ((isOpenRouter || isNousPortal) && (isClaude || isKimi) && !anthropicWire) return [true, false];
  if (isNousPortal && model.includes("qwen")) return [true, false];
  if (anthropicWire && isClaude) return [true, true]; // a third-party Anthropic-compatible gateway
  if (anthropicWire && minimax) return [true, true];
  if (ALIBABA_FAMILY_PROVIDERS.has(provider) && model.includes("qwen")) return [true, false];
  return [false, false];
}

function marker(ttl: CacheTtl | undefined): Dict {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

const textPart = (text: string, cc?: Dict): Dict => (cc ? { type: "text", text, cache_control: { ...cc } } : { type: "text", text });

/** `_can_carry_marker`. */
function canCarry(m: Message, native: boolean): boolean {
  if (native) return true;
  const c = m.content;
  return Array.isArray(c) && c.length > 0 ? isDict(c[c.length - 1]) : typeof c === "string" && c !== "";
}

/** `_apply_cache_marker`. Changes `m`, which is a copy. */
function applyMarker(m: Message, cc: Dict, native: boolean): void {
  const role = m.role ?? "";
  const c = m.content;
  if ((role === "tool" && native) || c === null || c === undefined || c === "") {
    // The native tool message: a top-level marker, the converter moves it into tool_result.
    if (!((role === "tool" || role === "assistant") && !native)) m.cache_control = { ...cc };
  } else if (typeof c === "string") {
    m.content = [textPart(c, cc)];
  } else if (Array.isArray(c) && c.length > 0 && isDict(c[c.length - 1])) {
    c[c.length - 1] = { ...c[c.length - 1], cache_control: { ...cc } };
  }
}

/** `_apply_system_cache_markers`. Returns the number of markers used. */
function applySystemMarkers(m: Message, cc: Dict, prefix: string | null | undefined, native: boolean): number {
  const c = m.content;
  if (typeof prefix === "string" && prefix && typeof c === "string" && c.startsWith(prefix)) {
    const suffix = c.slice(prefix.length);
    if (suffix.trim()) {
      m.content = [textPart(prefix, cc), textPart(suffix, cc)];
      return 2;
    }
  }
  applyMarker(m, cc, native);
  return 1;
}

/** `apply_anthropic_cache_control`. Returns a new list; the input is not changed. */
export function applyAnthropicCacheControl(messages: readonly Message[], o: CachePlanOptions): Message[] {
  if (messages.length === 0) return [...messages];
  const out = [...messages];
  const cc = marker(o.ttl);
  let used = 0;
  if (out[0]!.role === "system") {
    out[0] = clone(out[0]!);
    used = applySystemMarkers(out[0]!, cc, o.staticSystemPrefix, o.native);
  }
  const candidates = out.map((m, i) => (m.role !== "system" && canCarry(m, o.native) ? i : -1)).filter((i) => i >= 0);
  for (const i of candidates.slice(-(4 - used))) {
    out[i] = clone(out[i]!);
    applyMarker(out[i]!, cc, o.native);
  }
  return out;
}

/**
 * `is_one_shot_request`: a request that no later call reads back from the cache (no tools,
 * no assistant or tool turns, at most one user turn: compaction summaries, titles). A
 * marker there only buys a cache write. Upstream's auxiliary client turns caching off for it.
 */
export function isOneShotRequest(messages: readonly Message[], tools: readonly unknown[]): boolean {
  if (tools.length > 0) return false;
  const roles = messages.map((m) => m.role);
  return roles.filter((r) => r === "user").length <= 1 && !roles.some((r) => r === "assistant" || r === "tool");
}

/**
 * The request-local plan for one destination: the messages with markers, or the
 * same list when the route does not cache or caching is off.
 */
export function planPromptCache(
  messages: readonly Message[],
  tools: readonly unknown[],
  r: { mode: ApiMode; model: string; baseUrl?: string | null | undefined; promptCaching?: false | { ttl?: CacheTtl } | undefined; staticSystemPrefix?: string | null | undefined },
): Message[] {
  if (r.promptCaching === false || isOneShotRequest(messages, tools)) return [...messages];
  const [cache, native] = anthropicPromptCachePolicy(r);
  if (!cache) return [...messages];
  // `effective_cache_ttl`: Qwen routes keep a 5m cache only.
  const asked = r.promptCaching?.ttl ?? "5m";
  const ttl: CacheTtl = asked === "1h" && r.model.toLowerCase().includes("qwen") ? "5m" : asked;
  return applyAnthropicCacheControl(messages, { native, ttl, staticSystemPrefix: r.staticSystemPrefix ?? null });
}
