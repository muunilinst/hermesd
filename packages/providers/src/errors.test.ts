import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyApiError, errorSourceOf, nonretryableCopy, siteCopy, summarizeApiError } from "./errors.ts";
import { failureText } from "./router.ts";
import { ProviderHttpError, StreamDroppedError } from "./sse.ts";

/**
 * Error text fixtures (guide 7.4: 12 common failures). The expected text is the
 * text of `agent/turn_failure_copy.py` with the fields filled in, captured here as static strings.
 */

const RETRY_TAIL = "it looks temporarily unavailable. Wait a minute and send /retry, or switch models with /model. To avoid this in future, add a backup provider with `hermes fallback add`.";

interface Fixture {
  name: string;
  status: number | null;
  body: string;
  reason: string;
  text: string;
  oauth?: boolean;
  message?: string;
  attempts?: number;
}

const FIXTURES: Fixture[] = [
  {
    name: "429 rate limit",
    status: 429,
    body: '{"error":{"message":"Rate limit reached for requests"}}',
    reason: "rate_limit",
    text: `Anthropic rate-limited every one of 3 attempts — ${RETRY_TAIL}\n\nProvider said: HTTP 429: Rate limit reached for requests`,
  },
  {
    name: "429 with a long reset window",
    status: 429,
    body: '{"error":{"message":"Rate limit reached. Your limit resets in 2 hours 5 minutes"}}',
    reason: "rate_limit",
    text: "Anthropic rate-limited every one of 3 attempts — its usage limit resets in ~3h. Send /retry after that, or switch models with /model. To avoid this in future, add a backup provider with `hermes fallback add`.\n\nProvider said: HTTP 429: Rate limit reached. Your limit resets in 2 hours 5 minutes",
  },
  {
    name: "529 overloaded",
    status: 529,
    body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    reason: "overloaded",
    text: `Anthropic reported it was overloaded on all 3 attempts — ${RETRY_TAIL}\n\nProvider said: HTTP 529: Overloaded`,
  },
  {
    name: "500 server error",
    status: 500,
    body: '{"error":{"message":"internal error"}}',
    reason: "server_error",
    text: `Anthropic returned a server error on all 3 attempts — ${RETRY_TAIL}\n\nProvider said: HTTP 500: internal error`,
  },
  {
    name: "502 Cloudflare page",
    status: 502,
    body: "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>Cloudflare Ray ID: <strong>abc123</strong></body></html>",
    reason: "server_error",
    text: `Anthropic returned a server error on all 3 attempts — ${RETRY_TAIL}\n\nProvider said: HTTP 502 — 502 Bad Gateway — Ray abc123`,
  },
  {
    name: "408 timeout",
    status: 408,
    body: '{"error":{"message":"Request timed out"}}',
    reason: "timeout",
    text: `Anthropic didn't respond in time on any of 3 attempts — ${RETRY_TAIL}\n\nProvider said: HTTP 408: Request timed out`,
  },
  {
    name: "401 API key",
    status: 401,
    body: '{"error":{"message":"Incorrect API key provided"}}',
    reason: "auth",
    text: "Anthropic rejected your API key, so the model can't be reached. Update it in Settings → Providers, or run `hermes setup` in a terminal.\n\nProvider said: HTTP 401: Incorrect API key provided",
  },
  {
    name: "401 OAuth",
    status: 401,
    body: '{"error":{"message":"token expired"}}',
    reason: "auth",
    oauth: true,
    text: "Anthropic rejected your sign-in, so the model can't be reached. Sign in again: `hermes auth add anthropic --type oauth`.\n\nProvider said: HTTP 401: token expired",
  },
  {
    name: "404 model not found",
    status: 404,
    body: '{"error":{"message":"The model `gpt-9` does not exist"}}',
    reason: "model_not_found",
    text: "Model 'claude-x' isn't available on Anthropic. Pick a different model with /model (or `hermes model` in a terminal).\n\nProvider said: HTTP 404: The model `gpt-9` does not exist",
  },
  {
    name: "400 malformed request",
    status: 400,
    body: '{"error":{"message":"Unsupported parameter: foo"}}',
    reason: "format_error",
    text: "Anthropic rejected this request as malformed, so the model didn't answer. Start a clean session with /new or switch models with /model; if it keeps happening, run `hermes doctor`.\n\nProvider said: HTTP 400: Unsupported parameter: foo",
  },
  {
    name: "400 role alternation",
    status: 400,
    body: '{"error":{"message":"roles must alternate between user and assistant"}}',
    reason: "role_alternation",
    text: "Anthropic requires user and assistant turns to strictly alternate and rejected this conversation's shape. Start a clean session with /new or switch models with /model.\n\nProvider said: HTTP 400: roles must alternate between user and assistant",
  },
  {
    name: "404 data policy",
    status: 404,
    body: '{"error":{"message":"No endpoints available matching your data policy"}}',
    reason: "provider_policy_blocked",
    text: "Anthropic refused this request because of a policy on your account (its data/privacy settings, or a block the model's upstream provider placed on the account), so the model didn't answer and retrying won't help. Check the account with the provider, or switch models with /model.\n\nProvider said: HTTP 404: No endpoints available matching your data policy",
  },
  {
    name: "403 CDN block",
    status: 403,
    body: "<html><title>Attention Required! | Cloudflare</title>Sorry, you have been blocked</html>",
    reason: "upstream_blocked",
    text: "A firewall/CDN in front of Anthropic blocked the request before it reached the model, so your key is probably fine. Set a custom User-Agent via the provider's extra_headers, check the proxy/WAF rules, or switch providers with /model.\n\nProvider said: HTTP 403 — Attention Required! | Cloudflare",
  },
  {
    name: "400 content filter",
    status: 400,
    body: '{"error":{"message":"Your request was flagged by our safety system","code":"content_filter"}}',
    reason: "content_policy_blocked",
    text: "Anthropic's safety filter refused this request, so the model didn't answer. That message has been left out of this conversation, so you're not stuck — just ask something else and you can keep going. Rewording it, removing any sensitive attachments, or switching models with /model can also help. If a later message is refused too, start a new chat with /new (in a Bot Chat, Archive it from its tab menu).\n\nProvider said: HTTP 400: Your request was flagged by our safety system",
  },
  {
    name: "402 billing",
    status: 402,
    body: '{"error":{"message":"Insufficient credits"}}',
    reason: "billing",
    text: "Anthropic rejected the request and retrying won't help. Pick another model with /model, or check the details in `~/.hermes/logs/agent.log`.\n\nProvider said: HTTP 402: Insufficient credits",
  },
];

describe("error text", () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const src = errorSourceOf(new ProviderHttpError(f.status!, f.body));
      const c = classifyApiError(src);
      assert.equal(c.reason, f.reason);
      const text = f.oauth
        ? nonretryableCopy(c, { provider: "anthropic", model: "claude-x", summary: summarizeApiError(src), oauth: true })
        : failureText(c, src, { provider: "anthropic", model: "claude-x", attempts: 3, resetSeconds: f.name.includes("long reset") ? 7500 : null });
      assert.equal(text, f.text);
    });
  }

  it("says the user is offline when the name does not resolve", () => {
    const src = errorSourceOf(new TypeError("getaddrinfo ENOTFOUND api.openai.com"));
    assert.equal(summarizeApiError(src), "Hermes can't reach the model provider. You may be offline. Check your internet connection and try again.");
    assert.equal(classifyApiError(src).reason, "timeout");
  });

  it("gives the TLS text for a certificate failure", () => {
    const c = classifyApiError({ status: null, message: "unable to verify the first certificate" });
    assert.equal(c.reason, "ssl_cert_verification");
    assert.equal(
      nonretryableCopy(c, { provider: "openai", model: "m", summary: "x" }),
      "Hermes couldn't verify OpenAI's security certificate, so the connection was refused. This is usually a corporate proxy or an outdated certificate store on this computer — see the terminal or `~/.hermes/logs/agent.log` for the exact fix, or try another provider with /model.\n\nProvider said: x",
    );
  });

  it("gives the site text for a context overflow", () => {
    assert.equal(
      siteCopy("context_overflow", { model: "gpt-4o" }),
      "This conversation has grown too long for gpt-4o to read, and Hermes couldn't shrink it enough automatically. Start a new session with /new (your history is kept), or try /compress once more. Switching to a model with a bigger context window also works.",
    );
  });

  it("names the Anthropic and Bedrock stream-drop texts", () => {
    assert.equal(new StreamDroppedError("Bedrock Converse stream ended before messageStop; response is incomplete").name, "StreamDroppedError");
  });
});

describe("classifier", () => {
  it("marks 429 as rotate and fall back, 401 as rotate, 5xx as plain retry", () => {
    const c429 = classifyApiError({ status: 429, message: "Too many requests" });
    assert.deepEqual([c429.reason, c429.retryable, c429.shouldRotateCredential, c429.shouldFallback], ["rate_limit", true, true, true]);
    const c401 = classifyApiError({ status: 401, message: "bad key" });
    assert.deepEqual([c401.reason, c401.retryable, c401.shouldRotateCredential, c401.shouldFallback], ["auth", false, true, true]);
    const c503 = classifyApiError({ status: 503, message: "unavailable" });
    assert.deepEqual([c503.reason, c503.retryable, c503.shouldFallback], ["overloaded", true, false]);
  });

  it("sends a 400 with a context message to compression", () => {
    const c = classifyApiError({ status: 400, message: "This model's maximum context length is 8192 tokens" });
    assert.deepEqual([c.reason, c.shouldCompress], ["context_overflow", true]);
  });

  it("treats a 402 usage window as a rate limit and a 402 with no window as billing", () => {
    assert.equal(classifyApiError({ status: 402, message: "Usage limit reached, try again in 5 minutes" }).reason, "rate_limit");
    assert.equal(classifyApiError({ status: 402, message: "Insufficient credits" }).reason, "billing");
  });

  it("treats a 429 quota wall as billing", () => {
    assert.equal(classifyApiError({ status: 429, message: "You exceeded your current quota" }).reason, "billing");
  });
});
