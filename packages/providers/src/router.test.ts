import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anthropicMessagesClient, chatCompletionsClient } from "./client.ts";
import { ALL_MODES, MODELS, PARALLEL_CONVERSATION, TOOLS } from "./fixtures.ts";
import { parseRetryAfter } from "./errors.ts";
import {
  EXHAUSTED_TTL_AUTH_S,
  EXHAUSTED_TTL_DEFAULT_S,
  EXHAUSTED_TTL_RATE_LIMIT_S,
  EXHAUSTED_TTL_SOLE_S,
  jitteredBackoff,
  newPool,
  poolMarkExhausted,
  poolSelect,
  primaryCooldown,
  rateLimitWait,
  zaiOverloadWait,
} from "./retry.ts";
import { ProviderRouter, type RouterTarget } from "./router.ts";
import { ScriptedModel, type ScriptStep } from "./scripted.ts";
import type { FetchFn } from "./types.ts";

const INPUT = { messages: PARALLEL_CONVERSATION, tools: TOOLS };
const zero = (): number => 0;

/** Route requests to a scripted model by host name. */
function dispatch(models: Record<string, { fetch: FetchFn }>): FetchFn {
  return (req, signal) => {
    const m = models[new URL(req.url).host];
    if (!m) throw new Error(`no model for ${req.url}`);
    return m.fetch(req, signal);
  };
}

function setup(primary: ScriptStep[], fallback: ScriptStep[] | null, opts: { keys?: string[]; now?: { t: number } } = {}) {
  const p = new ScriptedModel("chat_completions", primary);
  const f = new ScriptedModel("anthropic_messages", fallback ?? []);
  const sleeps: number[] = [];
  const clock = opts.now ?? { t: 1_000 };
  const targets: RouterTarget[] = [
    { provider: "openai", client: chatCompletionsClient({ model: MODELS.chat_completions, url: "https://primary.test/v1/chat/completions" }), ...(opts.keys ? { keys: opts.keys } : {}) },
  ];
  if (fallback) targets.push({ provider: "anthropic", client: anthropicMessagesClient({ model: MODELS.anthropic_messages, url: "https://fallback.test/v1/messages", apiKey: "fb" }) });
  const router = new ProviderRouter(targets, {
    fetch: dispatch({ "primary.test": p, "fallback.test": f }),
    sleep: async (ms) => void sleeps.push(ms),
    now: () => clock.t,
    random: zero,
  });
  return { router, p, f, sleeps, clock };
}

describe("backoff", () => {
  it("doubles from 2 s up to 60 s and adds jitter of at most half", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => jitteredBackoff(n, zero)), [2, 4, 8, 16, 32, 60, 60]);
    assert.equal(jitteredBackoff(1, () => 1), 3);
    assert.equal(jitteredBackoff(6, () => 1), 90);
  });

  it("lets Retry-After win and caps it at 600 s", () => {
    assert.equal(rateLimitWait(1, 7, zero), 7);
    assert.equal(rateLimitWait(1, 5000, zero), 600);
    assert.equal(rateLimitWait(3, null, zero), 8);
  });

  it("reads Retry-After as seconds or as a date", () => {
    assert.equal(parseRetryAfter("12"), 12);
    assert.equal(parseRetryAfter("-3"), 0);
    assert.equal(parseRetryAfter("junk"), null);
    const soon = new Date(Date.now() + 30_000).toUTCString();
    const v = parseRetryAfter(soon)!;
    assert.ok(v > 25 && v <= 30);
  });

  it("uses 3 short retries, then 30, 60, 90 and 120 s for Z.AI overload", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => zaiOverloadWait(n, zero)), [2, 4, 8, 30, 60, 90, 120, 120]);
  });

  it("doubles the primary cooldown from 60 s up to 4 h, and honours a reset time", () => {
    assert.deepEqual([0, 1, 2, 3, 10].map((n) => primaryCooldown(n, null)), [60, 120, 240, 480, 14400]);
    assert.equal(primaryCooldown(5, 90), 90);
  });
});

describe("credential pool", () => {
  it("fill_first always takes the first live key", () => {
    const pool = newPool(["a", "b", "c"], "fill_first");
    assert.deepEqual([0, 1, 2].map(() => poolSelect(pool, 0)), ["a", "a", "a"]);
    poolMarkExhausted(pool, "a", 0, 429, null);
    assert.equal(poolSelect(pool, 1), "b");
  });

  it("round_robin cycles and skips exhausted keys", () => {
    const pool = newPool(["a", "b", "c"], "round_robin");
    assert.deepEqual([0, 1, 2, 3].map(() => poolSelect(pool, 0)), ["a", "b", "c", "a"]);
    poolMarkExhausted(pool, "b", 0, 429, null);
    assert.deepEqual([0, 1, 2].map(() => poolSelect(pool, 1)), ["c", "a", "c"]);
  });

  it("least_used takes the key with the fewest requests", () => {
    const pool = newPool(["a", "b"], "least_used");
    assert.deepEqual([0, 1, 2, 3].map(() => poolSelect(pool, 0)), ["a", "b", "a", "b"]);
  });

  it("random picks by the random source", () => {
    const pool = newPool(["a", "b", "c"], "random");
    assert.equal(poolSelect(pool, 0, () => 0.99), "c");
    assert.equal(poolSelect(pool, 0, () => 0), "a");
  });

  it("keeps a key out for the status TTL: 401 5 min, 429 1 h, other 1 h, only key 1 min", () => {
    const pool = newPool(["a", "b", "c", "d"]);
    poolMarkExhausted(pool, "a", 100, 401, null);
    poolMarkExhausted(pool, "b", 100, 429, null);
    poolMarkExhausted(pool, "c", 100, 500, null);
    poolMarkExhausted(pool, "d", 100, 429, 42);
    assert.deepEqual(
      pool.entries.map((e) => e.exhaustedUntil - 100),
      [EXHAUSTED_TTL_AUTH_S, EXHAUSTED_TTL_RATE_LIMIT_S, EXHAUSTED_TTL_DEFAULT_S, 42],
    );
    const sole = newPool(["x"]);
    poolMarkExhausted(sole, "x", 0, 429, null);
    assert.equal(sole.entries[0]!.exhaustedUntil, EXHAUSTED_TTL_SOLE_S);
    assert.equal(poolSelect(sole, EXHAUSTED_TTL_SOLE_S - 1), null);
    assert.equal(poolSelect(sole, EXHAUSTED_TTL_SOLE_S), "x");
  });
});

describe("429 fallback", () => {
  it("falls back at once on a 429 when there is no other key", async () => {
    const { router, p, f, sleeps } = setup([{ status: 429, retryAfter: 1 }], [{ reply: "from the fallback" }]);
    const r = await router.call(INPUT, { callId: "c1" });
    assert.ok(r.ok);
    assert.equal(r.target, "anthropic");
    assert.equal(r.result.response.content, "from the fallback");
    assert.equal(p.requests.length, 1);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(sleeps, []);
    const fb = r.events.find((e) => e.type === "fallback");
    assert.deepEqual(fb && fb.type === "fallback" ? [fb.from, fb.to, fb.status, fb.label] : null, ["openai", "anthropic", "⚠️ Rate limited — switching to fallback provider...", "rate limit"]);
    // The fallback gets its own body, in its own format.
    assert.equal((f.requests[0]!.body as { system?: string }).system, "You are helpful.");
  });

  it("sends the same call id to the fallback", async () => {
    const { router, f } = setup([{ status: 429 }], [{ reply: "ok" }]);
    await router.call(INPUT, { callId: "turn:c3" });
    assert.equal(f.requests[0]!.callId, "turn:c3");
  });

  it("falls back at once on billing", async () => {
    const { router, f } = setup([{ status: 402, errorMessage: "Insufficient credits" }], [{ reply: "ok" }]);
    const r = await router.call(INPUT, { callId: "c" });
    assert.ok(r.ok);
    assert.equal(f.requests.length, 1);
    const fb = r.events.find((e) => e.type === "fallback");
    assert.equal(fb && fb.type === "fallback" ? fb.status : "", "⚠️ Billing or credits exhausted — switching to fallback provider...");
  });

  it("keeps the primary in cooldown for the next request, then goes back", async () => {
    const { router, p, f, clock } = setup([{ status: 429 }, { reply: "primary again" }], [{ reply: "fb 1" }, { reply: "fb 2" }]);
    const first = await router.call(INPUT, { callId: "c1" });
    assert.ok(first.ok && first.target === "anthropic");
    clock.t += 30; // inside the 60 s cooldown
    const second = await router.call(INPUT, { callId: "c2" });
    assert.ok(second.ok && second.target === "anthropic");
    assert.equal(p.requests.length, 1);
    clock.t += 31; // cooldown over
    const third = await router.call(INPUT, { callId: "c3" });
    assert.ok(third.ok && third.target === "openai");
    assert.equal(third.ok && third.result.response.content, "primary again");
    assert.equal(f.requests.length, 2);
  });

  it("ends with the rate-limit text when no fallback is left", async () => {
    const { router } = setup([{ status: 429, errorMessage: "Rate limit reached" }], null);
    const r = await router.call(INPUT, { callId: "c" });
    assert.ok(!r.ok);
    assert.equal(r.classified.reason, "rate_limit");
    assert.match(r.text, /^OpenAI is rate-limiting requests right now/);
  });
});

describe("key rotation", () => {
  it("retries once with the same key on a 429, then rotates", async () => {
    const { router, p, sleeps } = setup([{ status: 429, times: 2 }], null, { keys: ["k0", "k1"] });
    const r = await router.call(INPUT, { callId: "c" });
    assert.ok(r.ok);
    assert.deepEqual(p.requests.map((q) => q.headers.authorization), ["Bearer k0", "Bearer k0", "Bearer k1"]);
    assert.deepEqual(sleeps, [2000]);
    assert.deepEqual(r.events.map((e) => e.type), ["attempt", "retry", "attempt", "rotate", "attempt"]);
  });

  it("rotates at once on a 401", async () => {
    const { router, p } = setup([{ status: 401, times: 1 }], null, { keys: ["bad", "good"] });
    const r = await router.call(INPUT, { callId: "c" });
    assert.ok(r.ok);
    assert.deepEqual(p.requests.map((q) => q.headers.authorization), ["Bearer bad", "Bearer good"]);
  });

  it("rotates at once on billing", async () => {
    const { router, p } = setup([{ status: 402, times: 1, errorMessage: "Insufficient credits" }], null, { keys: ["k0", "k1"] });
    assert.ok((await router.call(INPUT, { callId: "c" })).ok);
    assert.deepEqual(p.requests.map((q) => q.headers.authorization), ["Bearer k0", "Bearer k1"]);
  });

  it("falls back when every key is exhausted, and skips exhausted keys in the next request", async () => {
    const { router, p, f } = setup([{ status: 402, errorMessage: "Insufficient credits" }, { status: 402, errorMessage: "Insufficient credits" }], [{ reply: "fb" }, { reply: "fb2" }], { keys: ["k0", "k1"] });
    const r = await router.call(INPUT, { callId: "c1" });
    assert.ok(r.ok && r.target === "anthropic");
    assert.equal(p.requests.length, 2);
    assert.equal(f.requests.length, 1);
    // The primary also cools down only on rate limits. Billing leaves both keys exhausted for an hour.
    const again = await router.call(INPUT, { callId: "c2" });
    assert.ok(again.ok && again.target === "anthropic");
    assert.equal(p.requests.length, 2);
  });

  it("round-robin spreads requests over the keys", async () => {
    const p = new ScriptedModel("chat_completions", [{ reply: "1" }, { reply: "2" }, { reply: "3" }]);
    const router = new ProviderRouter([{ provider: "openai", client: chatCompletionsClient({ model: "gpt-4o", url: "https://primary.test/v1/chat/completions" }), keys: ["a", "b"], strategy: "round_robin" }], {
      fetch: dispatch({ "primary.test": p }),
      sleep: async () => {},
      random: zero,
    });
    for (const id of ["c1", "c2", "c3"]) await router.call(INPUT, { callId: id });
    assert.deepEqual(p.requests.map((q) => q.headers.authorization), ["Bearer a", "Bearer b", "Bearer a"]);
  });
});

describe("retry rules", () => {
  it("backs off 2 s and 4 s on 503 and then succeeds on the same target", async () => {
    const { router, p, sleeps } = setup([{ status: 503, times: 2 }], null);
    const r = await router.call(INPUT, { callId: "c" });
    assert.ok(r.ok);
    assert.equal(p.requests.length, 3);
    assert.deepEqual(sleeps, [2000, 4000]);
  });

  it("waits for Retry-After", async () => {
    const { router, sleeps } = setup([{ status: 503, times: 1, retryAfter: 7 }], null);
    assert.ok((await router.call(INPUT, { callId: "c" })).ok);
    assert.deepEqual(sleeps, [7000]);
  });

  it("recovers the primary once after the retries run out, then gives up with the server-error text", async () => {
    const { router, p, sleeps } = setup([{ status: 500, errorMessage: "internal error" }], null);
    const r = await router.call(INPUT, { callId: "c" });
    assert.ok(!r.ok);
    assert.equal(p.requests.length, 8);
    assert.equal(sleeps.length, 7);
    assert.match(r.text, /^OpenAI returned a server error on all 8 attempts/);
  });

  it("falls back after two failed retries on a timeout", async () => {
    let calls = 0;
    const f = new ScriptedModel("anthropic_messages", [{ reply: "fb" }]);
    const router = new ProviderRouter(
      [
        { provider: "openai", client: chatCompletionsClient({ model: "gpt-4o", url: "https://primary.test/v1/chat/completions" }) },
        { provider: "anthropic", client: anthropicMessagesClient({ model: "claude-sonnet-4-5", url: "https://fallback.test/v1/messages" }) },
      ],
      {
        fetch: (req, signal) => {
          if (new URL(req.url).host === "primary.test") {
            calls += 1;
            throw new TypeError("fetch failed");
          }
          return f.fetch(req, signal);
        },
        sleep: async () => {},
        random: zero,
      },
    );
    const r = await router.call(INPUT, { callId: "c" });
    assert.ok(r.ok && r.target === "anthropic");
    assert.equal(calls, 3);
  });

  it("falls back once on 401 with no pool, and fails on the second auth error", async () => {
    const { router, f } = setup([{ status: 401 }], [{ status: 401 }]);
    const r = await router.call(INPUT, { callId: "c" });
    assert.ok(!r.ok);
    assert.equal(r.classified.reason, "auth");
    assert.equal(f.requests.length, 1);
    assert.match(r.text, /rejected your API key/);
  });

  it("does not retry a malformed request", async () => {
    const { router, p } = setup([{ status: 400, errorMessage: "Unsupported parameter: foo" }], null);
    const r = await router.call(INPUT, { callId: "c" });
    assert.ok(!r.ok);
    assert.equal(p.requests.length, 1);
  });

  it("passes an abort through", async () => {
    const ac = new AbortController();
    const { router } = setup([{ hold: "never" }], null);
    const pending = router.call(INPUT, { callId: "c", signal: ac.signal });
    ac.abort();
    await assert.rejects(pending, { name: "AbortError" });
  });
});

describe("every mode as a fallback target", () => {
  for (const mode of ALL_MODES) {
    it(`falls back from chat_completions to ${mode}`, async () => {
      const p = new ScriptedModel("chat_completions", [{ status: 429 }]);
      const f = new ScriptedModel(mode, [{ reply: `via ${mode}` }]);
      const { createModelClient } = await import("./client.ts");
      const router = new ProviderRouter(
        [
          { provider: "openai", client: chatCompletionsClient({ model: "gpt-4o", url: "https://primary.test/v1/chat/completions" }) },
          { provider: "other", client: createModelClient(mode, { model: MODELS[mode], ...(mode === "bedrock_converse" ? {} : { url: `https://fallback.test/${mode === "anthropic_messages" ? "v1/messages" : mode === "codex_responses" ? "v1/responses" : "v1/chat/completions"}` }), ...(mode === "bedrock_converse" ? { url: "https://fallback.test" } : {}) }) },
        ],
        { fetch: dispatch({ "primary.test": p, "fallback.test": f }), sleep: async () => {}, random: zero },
      );
      const r = await router.call(INPUT, { callId: "c" });
      assert.ok(r.ok);
      assert.equal(r.result.response.content, `via ${mode}`);
    });
  }
});

describe("concurrent requests", () => {
  it("a 429 from the primary is not charged to the fallback another request moved to", async () => {
    // Both requests reach the primary, then both get 429. Each must fall back on its own.
    const { router, p, f } = setup(
      [{ status: 429, hold: "a" }, { status: 429, hold: "b" }],
      [{ reply: "fallback one" }, { reply: "fallback two" }],
    );
    const one = router.call(INPUT, { callId: "c1" });
    const two = router.call(INPUT, { callId: "c2" });
    while (p.requests.length < 2) await new Promise((r) => setImmediate(r));
    p.release("a");
    const r1 = await one;
    p.release("b");
    const r2 = await two;
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true, r2.ok ? "" : r2.text);
    assert.equal(f.requests.length, 2);
  });
});
