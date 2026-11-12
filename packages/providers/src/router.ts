import type { ModelClient, SendResult } from "./client.ts";
import {
  type ClassifiedError,
  classifyApiError,
  contentPolicyCopy,
  eagerFallbackStatus,
  errorSourceOf,
  exhaustedCopy,
  fallbackReasonText,
  nonretryableCopy,
  providerLabel,
  providerRetryAfter,
  resetDelayFromMessage,
  summarizeApiError,
} from "./errors.ts";
import { type Decision, type PoolStrategy, type Random, type RouterState, decide, newRouterState, onSuccess, poolSelect, restorePrimary } from "./retry.ts";
import { ProviderHttpError } from "./sse.ts";
import type { FetchFn, ModelCallInput } from "./types.ts";

/**
 * Provider fallback with key rotation: the in-process form of upstream's retry loop
 * (`agent_loop` + `turn_recovery.route_classified_error`). Decisions come from
 * `retry.ts:decide`; this class only runs them: pick a key, build the body for the
 * active target, send, classify, sleep, rotate or fall back.
 *
 * A fallback target may use another API mode, so the body is built again from the
 * same `ModelCallInput` for each target.
 */

export interface RouterTarget {
  /** The provider slug, for messages (`anthropic`, `openrouter`, ...). */
  provider: string;
  client: ModelClient;
  /** API keys for the credential pool. Empty when the client has its own key or needs none. */
  keys?: string[];
  strategy?: PoolStrategy;
  zai?: boolean;
}

export type RouterEvent =
  | { type: "attempt"; target: string; mode: string; keyId: string | null }
  | { type: "retry"; waitS: number; why: string }
  | { type: "rotate"; why: string }
  | { type: "fallback"; from: string; to: string; why: string; status: string; label: string }
  | { type: "fail"; why: string };

export interface RouterDeps {
  fetch: FetchFn;
  /** Wait for `ms`. Tests pass a fake that records the delays. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Seconds since the epoch. */
  now?: () => number;
  random?: Random;
  maxRetries?: number;
  onEvent?: (e: RouterEvent) => void;
}

export type RouterResult =
  | { ok: true; result: SendResult; target: string; events: RouterEvent[] }
  | { ok: false; text: string; classified: ClassifiedError; events: RouterEvent[] };

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });

export class ProviderRouter {
  readonly state: RouterState;
  readonly #targets: RouterTarget[];
  readonly #deps: RouterDeps;

  constructor(targets: RouterTarget[], deps: RouterDeps, state?: RouterState) {
    if (targets.length === 0) throw new Error("a router needs at least one target");
    this.#targets = targets;
    this.#deps = deps;
    this.state = state ?? newRouterState(targets.map((t) => ({ name: t.provider, keys: (t.keys ?? []).map((_k, i) => `key-${i}`), ...(t.strategy ? { strategy: t.strategy } : {}) })));
  }

  async call(input: Omit<ModelCallInput, "model"> & { model?: string }, ctx: { callId: string; signal?: AbortSignal }): Promise<RouterResult> {
    const now = this.#deps.now ?? (() => Date.now() / 1000);
    const sleep = this.#deps.sleep ?? realSleep;
    const events: RouterEvent[] = [];
    const emit = (e: RouterEvent): void => {
      events.push(e);
      this.#deps.onEvent?.(e);
    };
    // The health of each target (cooldowns, key pools) is shared by every request. Which target this
    // request is on, and its retry counters, are its own: with a shared `active`, a 429 that a request
    // got from the primary was charged to the fallback that a concurrent request had moved to.
    const st: RouterState = { ...this.state, targets: this.state.targets };
    restorePrimary(st, now());
    let attempts = 0;
    for (;;) {
      const target = this.#targets[st.active]!;
      const ts = st.targets[st.active]!;
      let exhaustedPool = false;
      if (st.keyId === null && (target.keys?.length ?? 0) > 0) {
        st.keyId = poolSelect(ts.pool, now(), this.#deps.random);
        exhaustedPool = st.keyId === null;
      }
      const apiKey = st.keyId !== null ? target.keys?.[Number(st.keyId.slice(4))] : undefined;
      emit({ type: "attempt", target: target.provider, mode: target.client.mode, keyId: st.keyId });
      attempts += 1;

      let src;
      let retryAfter: number | null = null;
      if (exhaustedPool) {
        src = { status: 429, message: "all credentials of this provider are cooling down", body: null };
      } else {
        try {
          const body = target.client.buildBody(input);
          const result = await target.client.send(body, { callId: ctx.callId, fetch: this.#deps.fetch, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(apiKey ? { apiKey } : {}) });
          onSuccess(st);
          return { ok: true, result, target: target.provider, events };
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") throw e;
          src = errorSourceOf(e);
          if (e instanceof ProviderHttpError) retryAfter = providerRetryAfter(e);
        }
      }
      const classified = classifyApiError(src);
      const transport = src.status === null;
      const before = st.active;
      const d: Decision = decide(st, {
        error: classified,
        retryAfterS: retryAfter,
        transport,
        now: now(),
        ...(this.#deps.random ? { random: this.#deps.random } : {}),
        ...(this.#deps.maxRetries !== undefined ? { maxRetries: this.#deps.maxRetries } : {}),
        ...(target.zai ? { zai: true } : {}),
      });
      switch (d.kind) {
        case "retry":
          emit({ type: "retry", waitS: d.waitS, why: d.why });
          await sleep(d.waitS * 1000, ctx.signal);
          break;
        case "rotate":
          emit({ type: "rotate", why: d.why });
          break;
        case "fallback": {
          const to = this.#targets[st.active]!.provider;
          emit({
            type: "fallback",
            from: this.#targets[before]!.provider,
            to,
            why: d.why,
            status: eagerFallbackStatus(classified, classified.reason === "upstream_rate_limit", transport),
            label: fallbackReasonText(d.reason),
          });
          break;
        }
        case "fail": {
          emit({ type: "fail", why: d.why });
          const text = failureText(classified, src, { provider: target.provider, model: target.client.model, attempts, resetSeconds: resetDelayFromMessage(classified.message) });
          return { ok: false, text, classified, events };
        }
      }
    }
  }
}

/** The user text for a failure that ended the request. `turn_failure_copy.py`. */
export function failureText(
  c: ClassifiedError,
  src: Parameters<typeof summarizeApiError>[0],
  a: { provider: string; model: string; attempts: number; resetSeconds?: number | null },
): string {
  const label = providerLabel(a.provider);
  const summary = summarizeApiError(src);
  if (c.reason === "content_policy_blocked") return contentPolicyCopy({ label, summary });
  const retriable = ["rate_limit", "upstream_rate_limit", "overloaded", "server_error", "timeout", "unknown", "billing"].includes(c.reason);
  if (retriable && c.reason !== "billing") return exhaustedCopy(c.reason, { label, attempts: a.attempts, summary, resetSeconds: a.resetSeconds ?? null });
  return nonretryableCopy(c, { provider: a.provider, model: a.model, summary });
}
