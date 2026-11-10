/**
 * When to compress.
 *
 * Port of upstream `agent/context_compressor.py`: `_effective_threshold_percent`,
 * `_compute_threshold_tokens`, `should_compress_info`, `lean_tail_budget` (from
 * `context_compressor_tail.py`), the tail and summary budgets, and of
 * `gateway/run_turn_hygiene.py`: `_hmwa_hygiene_plan`.
 *
 * Two triggers:
 *
 * 1. The agent compressor, before a model call: 50% of the context by default.
 *    The guide says 50%. Upstream has more rules around it, and they are kept:
 *    a window under 512K tokens is raised to 75%, the result is not below 64K
 *    tokens, and where that floor binds, the trigger is at most 85% of the
 *    window. So 50% is exact only for windows of 512K tokens and more.
 * 2. The gateway "hygiene" safety net, before the agent runs: 85% of the
 *    window, or 5000 messages.
 */

/** Upstream MINIMUM_CONTEXT_LENGTH (agent/model_metadata.py). */
export const MINIMUM_CONTEXT_LENGTH = 64_000;
const SMALL_CTX_WINDOW_LIMIT = 512_000;
const SMALL_CTX_THRESHOLD_PERCENT = 0.75;
const MIN_CTX_TRIGGER_RATIO = 0.85;
const MIN_SUMMARY_TOKENS = 2000;
const SUMMARY_RATIO = 0.2;
const SUMMARY_TOKENS_CEILING = 10_000;
const LEAN_TAIL_FLOOR_TOKENS = 10_000;
const LEAN_TAIL_CAP_TOKENS = 25_000;
const TAIL_MAX_CONTEXT_FRACTION = 0.2;
const TAIL_MAX_THRESHOLD_FRACTION = 0.5;

/** The knobs of the compressor. The defaults are upstream's. A test can lower the floors. */
export interface CompressionConfig {
  /** `compression.threshold`. Default 0.5. */
  thresholdPercent: number;
  /** `compression.protect_first_n`. Default 3. */
  protectFirstN: number;
  /** `compression.protect_last_n`. Default 20. */
  protectLastN: number;
  /** The tokens that the provider keeps for the answer. Default: none. */
  maxTokens: number | undefined;
  /** `compression.threshold_tokens`: an absolute cap on the trigger. */
  thresholdTokensCap: number | undefined;
  /** The floor of the trigger. Upstream MINIMUM_CONTEXT_LENGTH. */
  minimumContextLength: number;
  /** Windows under this size trigger at 75% or more. */
  smallContextWindowLimit: number;
  /** The gateway hygiene percent. Default 0.85. */
  hygienePercent: number;
  /** The gateway hygiene message limit. Default 5000. */
  hygieneHardMessageLimit: number;
}

export const DEFAULT_COMPRESSION: CompressionConfig = {
  thresholdPercent: 0.5,
  protectFirstN: 3,
  protectLastN: 20,
  maxTokens: undefined,
  thresholdTokensCap: undefined,
  minimumContextLength: MINIMUM_CONTEXT_LENGTH,
  smallContextWindowLimit: SMALL_CTX_WINDOW_LIMIT,
  hygienePercent: 0.85,
  hygieneHardMessageLimit: 5000,
};

export function compressionConfig(partial: Partial<CompressionConfig> = {}): CompressionConfig {
  return { ...DEFAULT_COMPRESSION, ...Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)) } as CompressionConfig;
}

/** Upstream `_effective_threshold_percent`: a raise-only floor for small windows. */
export function effectiveThresholdPercent(contextLength: number, thresholdPercent: number, cfg: CompressionConfig = DEFAULT_COMPRESSION): number {
  if (contextLength && contextLength < cfg.smallContextWindowLimit) return Math.max(thresholdPercent, SMALL_CTX_THRESHOLD_PERCENT);
  return thresholdPercent;
}

/** Upstream `_compute_threshold_tokens`. */
export function computeThresholdTokens(
  contextLength: number,
  thresholdPercent: number,
  maxTokens: number | undefined,
  minimumContextLength = MINIMUM_CONTEXT_LENGTH,
): number {
  const w = contextLength - (maxTokens ?? 0);
  const effectiveWindow = w > 0 ? w : contextLength;
  const pctValue = Math.trunc(effectiveWindow * thresholdPercent);
  let floored = Math.max(pctValue, minimumContextLength);
  // The floor must not use up the room for the answer: where it binds, the trigger is at most 85%.
  const triggerCap = Math.trunc(effectiveWindow * MIN_CTX_TRIGGER_RATIO);
  if (effectiveWindow > 0 && floored > pctValue && floored > triggerCap) floored = Math.max(pctValue, triggerCap);
  // A percent at or above the window cannot be reached: trigger at 85% instead.
  if (effectiveWindow > 0 && floored >= effectiveWindow) return Math.max(1, Math.min(triggerCap, effectiveWindow - 1));
  return floored;
}

/** The trigger of the agent compressor, in tokens. */
export function thresholdTokens(contextLength: number, cfg: CompressionConfig = DEFAULT_COMPRESSION): number {
  const pct = effectiveThresholdPercent(contextLength, cfg.thresholdPercent, cfg);
  let t = computeThresholdTokens(contextLength, pct, cfg.maxTokens, cfg.minimumContextLength);
  if (cfg.thresholdTokensCap !== undefined && cfg.thresholdTokensCap > 0) t = Math.min(t, Math.min(cfg.thresholdTokensCap, contextLength));
  return t;
}

/** Upstream `should_compress_info` (without the anti-thrash state, which the caller keeps): at or above the trigger. */
export function shouldCompress(promptTokens: number, contextLength: number, cfg: CompressionConfig = DEFAULT_COMPRESSION): boolean {
  return promptTokens >= thresholdTokens(contextLength, cfg);
}

/** The trigger of the gateway safety net (upstream `int(context_length * threshold_pct)`). */
export function hygieneThresholdTokens(contextLength: number, cfg: CompressionConfig = DEFAULT_COMPRESSION): number {
  return Math.trunc(contextLength * cfg.hygienePercent);
}

/** Upstream `_hmwa_hygiene_plan`: the history is at or above 85% of the window, or has too many messages. */
export function hygieneNeeded(historyTokens: number, messageCount: number, contextLength: number, cfg: CompressionConfig = DEFAULT_COMPRESSION): boolean {
  return historyTokens >= hygieneThresholdTokens(contextLength, cfg) || messageCount >= cfg.hygieneHardMessageLimit;
}

/** Upstream `lean_tail_budget`. */
export function leanTailBudget(contextLength: number, threshold: number): number {
  let floor = LEAN_TAIL_FLOOR_TOKENS;
  let windowTerm = Math.min(LEAN_TAIL_CAP_TOKENS, Math.trunc(contextLength * 0.025));
  if (threshold > 0) {
    const share = Math.trunc(threshold * TAIL_MAX_THRESHOLD_FRACTION);
    floor = Math.min(floor, share);
    if (threshold > MIN_SUMMARY_TOKENS) windowTerm = Math.min(windowTerm, share);
  }
  return Math.max(floor, windowTerm);
}

/** Upstream `ContextCompressor.tail_token_budget` in the default "lean" mode. */
export function tailTokenBudget(contextLength: number, cfg: CompressionConfig = DEFAULT_COMPRESSION): number {
  let budget = leanTailBudget(contextLength, thresholdTokens(contextLength, cfg));
  if (contextLength > 0) budget = Math.min(budget, Math.trunc(contextLength * TAIL_MAX_CONTEXT_FRACTION));
  return Math.max(1, budget);
}

/** Upstream `_tail_soft_ceiling`: optional tail rows may overrun the budget 1.5 times. */
export function tailSoftCeiling(budget: number, contextLength: number): number {
  let ceiling = Math.trunc(budget * 1.5);
  if (contextLength > 0) ceiling = Math.min(ceiling, Math.trunc(contextLength * TAIL_MAX_CONTEXT_FRACTION));
  return Math.max(ceiling, budget);
}

/** Upstream `max_summary_tokens`. */
export function maxSummaryTokens(contextLength: number): number {
  return Math.min(Math.trunc(contextLength * 0.05), SUMMARY_TOKENS_CEILING);
}

/** Upstream `_compute_summary_budget`: the size of the summary, from the size of the text to summarise. */
export function summaryBudget(contentTokens: number, contextLength: number): number {
  const budget = Math.trunc(contentTokens * SUMMARY_RATIO);
  return Math.max(MIN_SUMMARY_TOKENS, Math.min(budget, maxSummaryTokens(contextLength)));
}
