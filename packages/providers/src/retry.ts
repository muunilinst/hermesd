import { type ClassifiedError, type FailoverReason, resetDelayFromMessage } from "./errors.ts";

/**
 * Retry, backoff, key rotation and provider fallback.
 *
 * Upstream files:
 * - `agent/retry_utils.py` (`jittered_backoff`, `parse_retry_after_seconds`, the caps).
 * - `agent/credential_pool.py` (`PooledCredential`, `CredentialPool`, the four strategies, the exhaustion TTLs).
 * - `agent/turn_recovery.py` (`route_classified_error`: when to fall back at once).
 * - `agent/chat_completion_helpers.py` (the rate-limit cooldown of the primary).
 *
 * All state is plain JSON (`RouterState`) and all decisions are pure functions of
 * `(state, error, now, random)`. A caller can keep the state in `pending_call.data`.
 */

// ---------------------------------------------------------------- caps and defaults

/** `agent_init.py`: `api_max_retries` */
export const API_MAX_RETRIES = 3;
export const BACKOFF_BASE_S = 2.0;
export const BACKOFF_MAX_S = 60.0;
export const BACKOFF_JITTER_RATIO = 0.5;
/** `retry_utils.py:RETRY_AFTER_CAP_S` */
export const RETRY_AFTER_CAP_S = 600;
/** `retry_utils.py:LIVE_RETRY_WAIT_CAP_S`: the longest single wait a live caller sleeps. */
export const LIVE_RETRY_WAIT_CAP_S = 60;
/** Z.AI overload: after 3 short retries, wait 30, 60, 90, 120 s with 20% jitter. */
export const ZAI_OVERLOAD_SCHEDULE_S = [30, 60, 90, 120] as const;
export const ZAI_SHORT_RETRIES = 3;
export const ZAI_JITTER_RATIO = 0.2;
/** Rate-limit cooldown of a primary provider: `min(60 * 2^n, 14400)`. */
export const COOLDOWN_BASE_S = 60;
export const COOLDOWN_MAX_S = 14400;

export type Random = () => number;

/** `jittered_backoff(attempt)`: `min(base * 2^(attempt-1), max)` plus `uniform(0, ratio * delay)`. Attempt starts at 1. */
export function jitteredBackoff(attempt: number, random: Random = Math.random, base = BACKOFF_BASE_S, max = BACKOFF_MAX_S, ratio = BACKOFF_JITTER_RATIO): number {
  const exp = Math.max(0, attempt - 1);
  const delay = exp >= 31 ? max : Math.min(base * 2 ** exp, max);
  return delay + random() * ratio * delay;
}

/** `adaptive rate-limit backoff`: a `Retry-After` wins, capped at 600 s. Otherwise the jittered backoff. */
export function rateLimitWait(attempt: number, retryAfterS: number | null, random: Random = Math.random): number {
  if (retryAfterS !== null && retryAfterS > 0) return Math.min(retryAfterS, RETRY_AFTER_CAP_S);
  return jitteredBackoff(attempt, random);
}

/** The wait for an overloaded Z.AI endpoint, by retry number (1-based). */
export function zaiOverloadWait(retry: number, random: Random = Math.random): number {
  if (retry <= ZAI_SHORT_RETRIES) return jitteredBackoff(retry, random);
  const base = ZAI_OVERLOAD_SCHEDULE_S[Math.min(retry - ZAI_SHORT_RETRIES, ZAI_OVERLOAD_SCHEDULE_S.length) - 1]!;
  return base + random() * ZAI_JITTER_RATIO * base;
}

/** The cooldown of a primary provider after its n-th (0-based) rate limit. A provider reset time wins. */
export function primaryCooldown(consecutive: number, resetSeconds: number | null): number {
  if (resetSeconds !== null && resetSeconds > 0) return resetSeconds;
  return Math.min(COOLDOWN_BASE_S * 2 ** Math.min(consecutive, 20), COOLDOWN_MAX_S);
}

// ---------------------------------------------------------------- credential pool

export type PoolStrategy = "fill_first" | "round_robin" | "random" | "least_used";

export interface PooledCredential {
  id: string;
  /** Seconds since the epoch until which the key is skipped. 0 when it is usable. */
  exhaustedUntil: number;
  requestCount: number;
}

export interface PoolState {
  strategy: PoolStrategy;
  entries: PooledCredential[];
  /** round_robin: the index of the next key. */
  cursor: number;
}

/** `credential_pool.py` exhaustion TTLs (seconds). */
export const EXHAUSTED_TTL_AUTH_S = 300;
export const EXHAUSTED_TTL_RATE_LIMIT_S = 3600;
export const EXHAUSTED_TTL_DEFAULT_S = 3600;
/** A pool with one key must not lock itself out for long. */
export const EXHAUSTED_TTL_SOLE_S = 60;

export function newPool(ids: string[], strategy: PoolStrategy = "fill_first"): PoolState {
  return { strategy, entries: ids.map((id) => ({ id, exhaustedUntil: 0, requestCount: 0 })), cursor: 0 };
}

export function exhaustedTtl(status: number | null, sole: boolean, resetSeconds: number | null): number {
  if (resetSeconds !== null && resetSeconds > 0) return resetSeconds;
  if (sole) return EXHAUSTED_TTL_SOLE_S;
  if (status === 401) return EXHAUSTED_TTL_AUTH_S;
  if (status === 429) return EXHAUSTED_TTL_RATE_LIMIT_S;
  return EXHAUSTED_TTL_DEFAULT_S;
}

/** `CredentialPool.select`. Returns the id of the next usable key, or null when all are exhausted. The state changes (counts, cursor). */
export function poolSelect(pool: PoolState, now: number, random: Random = Math.random): string | null {
  const live = pool.entries.filter((e) => e.exhaustedUntil <= now);
  if (live.length === 0) return null;
  let pick: PooledCredential;
  switch (pool.strategy) {
    case "fill_first":
      pick = live[0]!;
      break;
    case "round_robin": {
      const n = pool.entries.length;
      let chosen: PooledCredential | undefined;
      for (let i = 0; i < n && !chosen; i++) {
        const e = pool.entries[(pool.cursor + i) % n]!;
        if (e.exhaustedUntil <= now) {
          chosen = e;
          pool.cursor = (pool.cursor + i + 1) % n;
        }
      }
      pick = chosen!;
      break;
    }
    case "random":
      pick = live[Math.min(live.length - 1, Math.floor(random() * live.length))]!;
      break;
    case "least_used":
      pick = live.reduce((a, b) => (b.requestCount < a.requestCount ? b : a));
      break;
  }
  pick.requestCount += 1;
  return pick.id;
}

export function poolMarkExhausted(pool: PoolState, id: string, now: number, status: number | null, resetSeconds: number | null): void {
  const e = pool.entries.find((x) => x.id === id);
  if (e) e.exhaustedUntil = now + exhaustedTtl(status, pool.entries.length === 1, resetSeconds);
}

/** Does another key exist that the next call could use? */
export function poolHasOther(pool: PoolState, current: string, now: number): boolean {
  return pool.entries.some((e) => e.id !== current && e.exhaustedUntil <= now);
}

// ---------------------------------------------------------------- the router state machine

export interface TargetState {
  name: string;
  pool: PoolState;
  /** Epoch seconds until which this target is cooling down after a rate limit. */
  cooldownUntil: number;
  /** How many rate limits in a row. It resets after a success. */
  rateLimitStreak: number;
}

export interface RouterState {
  /** The index of the target in use. 0 is the primary. */
  active: number;
  targets: TargetState[];
  /** Failed tries of the current request on the current target. */
  retryCount: number;
  /** `has_retried_429`: one retry on the same key before the key is rotated. */
  hasRetried429: boolean;
  /** A 401 or 403 falls back only once for the request. */
  authFallbackUsed: boolean;
  /** The current key id of the active target. */
  keyId: string | null;
  /** The primary was recovered once (a fresh try after the retries ran out). */
  primaryRecovered: boolean;
}

export function newRouterState(targets: Array<{ name: string; keys: string[]; strategy?: PoolStrategy }>): RouterState {
  return {
    active: 0,
    targets: targets.map((t) => ({ name: t.name, pool: newPool(t.keys, t.strategy ?? "fill_first"), cooldownUntil: 0, rateLimitStreak: 0 })),
    retryCount: 0,
    hasRetried429: false,
    authFallbackUsed: false,
    keyId: null,
    primaryRecovered: false,
  };
}

export type Decision =
  | { kind: "retry"; waitS: number; why: string; sameKey: boolean }
  | { kind: "rotate"; waitS: number; why: string }
  | { kind: "fallback"; why: string; reason: FailoverReason; waitS: 0 }
  | { kind: "fail"; why: string; reason: FailoverReason };

export interface DecideInput {
  error: ClassifiedError;
  retryAfterS: number | null;
  /** Is the failure a transport one (no HTTP status)? */
  transport: boolean;
  now: number;
  random?: Random;
  maxRetries?: number;
  /** The provider is Z.AI and the failure is an overload. */
  zai?: boolean;
}

const EAGER_REASONS: ReadonlySet<FailoverReason> = new Set(["rate_limit", "billing", "upstream_rate_limit"]);

function hasFallbackAfter(state: RouterState, now: number): boolean {
  return state.targets.some((t, i) => i > state.active && t.cooldownUntil <= now);
}

/**
 * Decide what to do after one failed try. Mirrors `turn_recovery.route_classified_error`
 * and the retry loop of `agent_loop`:
 *
 * 1. A failure that cannot be retried and has no fallback hint ends the request.
 * 2. Rate limit / billing / upstream rate limit: use the credential pool first. On a
 *    rate limit retry once with the same key (`hasRetried429`), then rotate. Billing and
 *    auth rotate at once. When no other key is usable, fall back at once.
 * 3. Auth (401/403) falls back once.
 * 4. Timeout and overloaded failures retry; after `retryCount >= 2` they fall back.
 * 5. When the retries run out: recover the primary once, then fall back, then fail.
 *
 * It changes `state` and returns the decision.
 */
export function decide(state: RouterState, input: DecideInput): Decision {
  const { error: c, now } = input;
  const random = input.random ?? Math.random;
  const max = input.maxRetries ?? API_MAX_RETRIES;
  const target = state.targets[state.active]!;
  const canFallback = hasFallbackAfter(state, now);
  const resetS = typeof c.errorContext.reset_at === "number" ? Math.max(0, (c.errorContext.reset_at as number) - now) : resetDelayFromMessage(c.message);

  const goFallback = (why: string): Decision => {
    if (c.reason === "rate_limit" || c.reason === "upstream_rate_limit") {
      target.cooldownUntil = now + primaryCooldown(target.rateLimitStreak, resetS);
      target.rateLimitStreak += 1;
    }
    return advance(state, now, why, c.reason);
  };

  // Rotation inside the pool comes before the fallback.
  if (c.shouldRotateCredential && state.keyId !== null) {
    if (c.reason === "rate_limit" && !state.hasRetried429) {
      state.hasRetried429 = true;
      state.retryCount += 1;
      return { kind: "retry", waitS: Math.min(rateLimitWait(state.retryCount, input.retryAfterS, random), LIVE_RETRY_WAIT_CAP_S), why: "rate limit: one retry with the same key", sameKey: true };
    }
    poolMarkExhausted(target.pool, state.keyId, now, c.statusCode, resetS);
    if (poolHasOther(target.pool, state.keyId, now)) {
      state.hasRetried429 = false;
      state.keyId = null;
      return { kind: "rotate", waitS: 0, why: `${c.reason}: rotate to the next key` };
    }
  }

  if (EAGER_REASONS.has(c.reason)) {
    return canFallback ? goFallback(`${c.reason}: fall back at once`) : fail(state, c, `${c.reason}: no fallback left`, now, resetS);
  }

  if (c.reason === "auth" || c.reason === "auth_permanent") {
    if (!state.authFallbackUsed && canFallback) {
      state.authFallbackUsed = true;
      return goFallback("auth failed: fall back once");
    }
    return { kind: "fail", why: "auth failed", reason: c.reason };
  }

  if (!c.retryable && !c.shouldFallback) return { kind: "fail", why: "not retryable", reason: c.reason };
  if (c.shouldFallback && !c.retryable) {
    return canFallback ? goFallback(`${c.reason}: fall back`) : { kind: "fail", why: `${c.reason}: no fallback left`, reason: c.reason };
  }

  // Retryable: timeouts, overloads, server errors, unknown.
  state.retryCount += 1;
  if ((c.reason === "timeout" || c.reason === "overloaded" || input.transport) && state.retryCount >= 3 && canFallback) {
    return goFallback(`${c.reason}: ${state.retryCount - 1} retries used, fall back`);
  }
  if (state.retryCount > max) {
    if (!state.primaryRecovered && state.active === 0) {
      state.primaryRecovered = true;
      state.retryCount = 0;
      return { kind: "retry", waitS: jitteredBackoff(max, random), why: "retries used up: recover the primary once", sameKey: true };
    }
    return canFallback ? goFallback("retries used up: fall back") : { kind: "fail", why: "retries used up", reason: c.reason };
  }
  const waitS =
    c.reason === "overloaded" && input.zai ? zaiOverloadWait(state.retryCount, random) : rateLimitWait(state.retryCount, input.retryAfterS, random);
  return { kind: "retry", waitS: Math.min(waitS, input.zai ? Infinity : LIVE_RETRY_WAIT_CAP_S), why: `${c.reason}: retry ${state.retryCount} of ${max}`, sameKey: true };
}

function fail(state: RouterState, c: ClassifiedError, why: string, now: number, resetS: number | null): Decision {
  const target = state.targets[state.active]!;
  if (c.reason === "rate_limit" || c.reason === "upstream_rate_limit") {
    target.cooldownUntil = now + primaryCooldown(target.rateLimitStreak, resetS);
    target.rateLimitStreak += 1;
  }
  return { kind: "fail", why, reason: c.reason };
}

function advance(state: RouterState, now: number, why: string, reason: FailoverReason): Decision {
  let next = state.active + 1;
  while (next < state.targets.length && state.targets[next]!.cooldownUntil > now) next += 1;
  state.active = Math.min(next, state.targets.length - 1);
  state.retryCount = 0;
  state.hasRetried429 = false;
  state.keyId = null;
  return { kind: "fallback", why, reason, waitS: 0 };
}

/** After a good answer: the key counts, the streaks end, the next request starts at the primary if its cooldown is over. */
export function onSuccess(state: RouterState): void {
  const t = state.targets[state.active]!;
  t.rateLimitStreak = 0;
  state.retryCount = 0;
  state.hasRetried429 = false;
  state.authFallbackUsed = false;
  state.primaryRecovered = false;
}

/** At the start of a request: go back to the first target that is not cooling down. */
export function restorePrimary(state: RouterState, now: number): void {
  const first = state.targets.findIndex((t) => t.cooldownUntil <= now);
  state.active = first < 0 ? state.targets.length - 1 : first;
  state.retryCount = 0;
  state.hasRetried429 = false;
  state.authFallbackUsed = false;
  state.keyId = null;
}
