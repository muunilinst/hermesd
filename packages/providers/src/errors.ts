import { ProviderHttpError, StreamDroppedError } from "./sse.ts";
import { type Dict, isDict } from "./types.ts";

/**
 * Error classification and the user text for model failures.
 *
 * Upstream files:
 * - `agent/error_classifier.py` (`classify_api_error`, the pattern tables, the status handlers).
 * - `agent/turn_failure_copy.py` (`exhausted_copy`, `nonretryable_copy`, `content_policy_copy`, `site_copy`).
 * - `agent/api_error_summary.py` (`_summarize_api_error`).
 *
 * Only the stages that do not need a provider profile are ported: the HTTP status,
 * the structured error code, the message patterns, and the transport type. The Nous,
 * xAI, Gemini, MoA and OpenRouter special cases are not ported (NOTES.md).
 */

export type FailoverReason =
  | "auth" | "auth_permanent" | "billing" | "rate_limit" | "upstream_rate_limit" | "upstream_blocked" | "overloaded"
  | "server_error" | "timeout" | "ssl_cert_verification" | "context_overflow" | "payload_too_large" | "model_not_found"
  | "provider_policy_blocked" | "content_policy_blocked" | "format_error" | "role_alternation" | "thinking_signature" | "unknown";

export interface ClassifiedError {
  reason: FailoverReason;
  statusCode: number | null;
  message: string;
  retryable: boolean;
  shouldCompress: boolean;
  shouldRotateCredential: boolean;
  shouldFallback: boolean;
  errorContext: Dict;
}

const BILLING_PATTERNS = [
  "insufficient credits", "insufficient_quota", "insufficient balance", "credit balance", "credits exhausted", "credits have been exhausted",
  "requires available credits", "account balance is too low", "no usable credits", "top up your credits", "payment required",
  "billing hard limit", "exceeded your current quota", "account is deactivated", "plan does not include", "out of extra usage",
  "out of funds", "run out of funds", "balance_depleted", "budget limit exceeded", "model_not_supported_on_free_tier",
  "not available on the free tier", "hard billing limit",
];
const UNVERIFIED_BILLING_PATTERNS = ["out of extra usage"];
const BILLING_ERROR_CODES = new Set([
  "insufficient_quota", "billing_not_active", "payment_required", "insufficient_credits", "no_usable_credits", "balance_depleted",
  "model_not_supported_on_free_tier", "member_spend_cap_exceeded", "terminal_quota_exhausted", "credit_balance_exhausted",
  "organization_spend_limit_exceeded", "organization_usage_limit_exceeded", "project_spend_limit_exceeded", "insufficient_credits_for_paid_model",
]);
const RATE_LIMIT_PATTERNS = [
  "rate limit", "rate_limit", "too many requests", "throttled", "requests per minute", "tokens per minute", "requests per day", "try again in",
  "please retry after", "resource exhausted", "resource_exhausted", "resource-exhausted", "resourceexhausted", "rate increased too quickly",
  "throttlingexception", "too many concurrent requests", "servicequotaexceededexception", "throttling",
];
const OVERLOADED_PATTERNS = [
  "overloaded", "temporarily overloaded", "service is temporarily overloaded", "service may be temporarily overloaded", "server is overloaded",
  "server overloaded", "server overload", "server_overload", "service overloaded", "service is overloaded", "upstream overloaded",
  "currently overloaded", "upstream model provider is temporarily unavailable. please try again in a moment.", "at capacity", "over capacity",
];
const USAGE_LIMIT_PATTERNS = ["usage limit", "quota", "limit exceeded", "key limit exceeded"];
const USAGE_LIMIT_TRANSIENT = ["try again", "retry", "resets at", "reset in", "resets in", "reset after", "available in", "wait", "requests remaining", "periodic", "window", "per minute", "per second"];
const PAYLOAD_TOO_LARGE_PATTERNS = ["request entity too large", "payload too large", "error code: 413", "request_too_large", "request exceeds the maximum size"];
const CONTEXT_OVERFLOW_PATTERNS = [
  "context length", "context size", "maximum context", "token limit", "too many tokens", "reduce the length", "exceeds the limit", "context window",
  "prompt is too long", "prompt exceeds max length", "max_tokens", "maximum number of tokens", "exceeds the max_model_len", "max_model_len",
  "prompt length", "input is too long", "maximum model length", "context length exceeded", "truncating input", "slot context", "n_ctx_slot",
  "tokens in request more than max tokens allowed", "max input token", "input token", "exceeds the maximum number of input tokens", "maximum allowed input length",
];
const MODEL_NOT_FOUND_PATTERNS = ["is not a valid model", "invalid model", "model not found", "model_not_found", "does not exist", "no such model", "unknown model", "unsupported model", "no endpoints found that support tool use", "is no longer free"];
const INVALID_MESSAGE_BODY = ["must have non-empty content", "messages must have non-empty", "invalid_request_body", "text content blocks must be non-empty", "content field is required", "messages: at least one message is required", "no user query found"];
const ROLE_ALTERNATION = ["roles must alternate", "role must alternate", "must alternate between", "consecutive user messages", "consecutive messages with the same role", "consecutive messages of the same role", "same role in a row", "multiple user messages in a row", "adjacent messages with the same role"];
const REQUEST_VALIDATION = ["unknown parameter", "unsupported parameter", "unrecognized request argument", "unknown_parameter", "unsupported_parameter"];
const PROVIDER_POLICY = ["no endpoints available matching your guardrail", "no endpoints available matching your data policy", "no endpoints found matching your data policy"];
const CONTENT_POLICY = [
  "flagged for possible cybersecurity risk", "trusted access for cyber", "violates our usage policies", "violates openai's usage policies", "your request was flagged by",
  "prompt was flagged by our safety", "responses cannot be generated due to safety", "content_filter", "responsibleaipolicyviolation", "new_sensitive",
  "content exists risk", "data may contain inappropriate content", "data_inspection_failed",
];
const AUTH_PATTERNS = ["invalid api key", "invalid_api_key", "gateway_auth_failed", "authentication", "unauthorized", "forbidden", "invalid token", "token expired", "token revoked", "access denied", "failed to extract accountid from token"];
const TIMEOUT_PATTERNS = ["timed out", "turn timed out", "request timed out", "deadline exceeded", "operation timed out", "upstream timed out"];
const CONNECTION_PATTERNS = [
  "connection refused", "econnrefused", "no route to host", "network is unreachable", "network unreachable", "name or service not known",
  "temporary failure in name resolution", "nodename nor servname provided", "getaddrinfo failed", "getaddrinfo enotfound", "eai_again",
  "fetch failed", "failed to fetch", "upstream connect error",
];
const SERVER_DISCONNECT = ["server disconnected", "peer closed connection", "connection reset by peer", "connection was closed", "network connection lost", "unexpected eof", "incomplete chunked read"];
const SSL_CERT = ["certificate verify failed", "certificate_verify_failed", "unable to get local issuer certificate", "self-signed certificate", "self signed certificate", "certificate has expired", "hostname mismatch, certificate is not valid", "unable to verify the first certificate"];
const UPSTREAM_BLOCKED = ["your request was blocked", "request blocked", "sorry, you have been blocked", "enable javascript and cookies to continue", "cdn-cgi/challenge-platform", "cf-browser-verification", "challenge-error-text", "__cf_chl", "cf-error-details", "attention required! | cloudflare"];
const EMPTY_RESPONSE = ["returned an empty response", "empty response despite retries", "provider returned an empty response", "model returning empty responses", "empty response stream"];
const MEMORY_CEILING = ["memory guard", "memory limit exceeded", "memory_guard_tier", "dynamic ceiling", "memory ceiling", "available memory", "out of memory", "insufficient memory", "prefill would require", "predicted peak would", "prefill safety cap", "metal_cap"];
const THINKING_WORDS = ["signature", "cannot be modified", "must remain as they were"];

type Verdict = Partial<Omit<ClassifiedError, "statusCode" | "message">> & { reason: FailoverReason };
const ROTATE_FALLBACK = { shouldRotateCredential: true, shouldFallback: true };
const ABORT_FALLBACK = { retryable: false, shouldFallback: true };
const V = {
  billing: { reason: "billing", retryable: false, ...ROTATE_FALLBACK } as Verdict,
  rate: { reason: "rate_limit", ...ROTATE_FALLBACK } as Verdict,
  authRotate: { reason: "auth", retryable: false, ...ROTATE_FALLBACK } as Verdict,
  authFallback: { reason: "auth", ...ABORT_FALLBACK } as Verdict,
  modelNotFound: { reason: "model_not_found", ...ABORT_FALLBACK } as Verdict,
  upstreamBlocked: { reason: "upstream_blocked", ...ABORT_FALLBACK } as Verdict,
  contentBlocked: { reason: "content_policy_blocked", ...ABORT_FALLBACK } as Verdict,
  format: { reason: "format_error", ...ABORT_FALLBACK } as Verdict,
  policy: { reason: "provider_policy_blocked", ...ABORT_FALLBACK } as Verdict,
  ssl: { reason: "ssl_cert_verification", ...ABORT_FALLBACK } as Verdict,
  overflow: { reason: "context_overflow", shouldCompress: true } as Verdict,
  payload: { reason: "payload_too_large", shouldCompress: true } as Verdict,
  overloaded: { reason: "overloaded" } as Verdict,
  server: { reason: "server_error" } as Verdict,
  timeout: { reason: "timeout" } as Verdict,
  unknown: { reason: "unknown" } as Verdict,
  roleAlt: { reason: "role_alternation", ...ABORT_FALLBACK } as Verdict,
  malformedArgs: { reason: "format_error", retryable: false, shouldFallback: false } as Verdict,
  thinking: { reason: "thinking_signature" } as Verdict,
};

const has = (msg: string, patterns: string[]): boolean => patterns.some((p) => msg.includes(p));

function billingHints(msg: string): Verdict {
  // An ambiguous body ("out of extra usage" also comes with a content filter) is marked unverified.
  return { ...V.billing, errorContext: has(msg, UNVERIFIED_BILLING_PATTERNS) ? { billing_unverified: true } : {} };
}

function classify402(msg: string): Verdict {
  const transient = has(msg, USAGE_LIMIT_PATTERNS) && has(msg, USAGE_LIMIT_TRANSIENT);
  return transient ? V.rate : billingHints(msg);
}

/** Seconds until a limit resets, from a body field, a header or free text. `error_classifier.py:_rate_limit_reset_seconds` + `retry_utils.py:reset_delay_from_message`. */
export function resetDelayFromMessage(message: string): number | null {
  if (!message) return null;
  let m = /quotaResetDelay[:\s"]+(\d+(?:\.\d+)?)(ms|s)/i.exec(message);
  if (m) return m[2]!.toLowerCase() === "ms" ? Number(m[1]) / 1000 : Number(m[1]);
  m = /retry\s+(?:after\s+)?(\d+(?:\.\d+)?)\s*(?:sec|secs|seconds|s\b)/i.exec(message);
  if (m) return Number(m[1]);
  m = /resets_in_seconds\W{1,4}(\d+(?:\.\d+)?)/i.exec(message);
  if (m) return Number(m[1]);
  m = /resets?\s+in\s+(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b\s*)?(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b)?/i.exec(message);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return null;
}

/** `retry_utils.py:parse_retry_after_seconds`: a number of seconds or an HTTP date. Zero means no usable wait. */
export function parseRetryAfter(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Math.max(0, value);
  const text = String(value).trim();
  if (!text) return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  const when = Date.parse(text);
  return Number.isNaN(when) ? null : Math.max(0, (when - Date.now()) / 1000);
}

/** `retry_utils.py:provider_retry_after_seconds`: the `Retry-After` header, else a `retry_after` body field. Positive only. */
export function providerRetryAfter(err: { headers?: Record<string, string>; body?: unknown }): number | null {
  const h = err.headers ?? {};
  let v = parseRetryAfter(h["retry-after"] ?? h["Retry-After"]);
  if (v === null && isDict(err.body)) {
    const nested = isDict(err.body.error) ? err.body.error : err.body;
    v = parseRetryAfter(nested.retry_after);
  }
  return v !== null && v > 0 ? v : null;
}

function bodyMessage(body: unknown): string {
  if (!isDict(body)) return "";
  const err = isDict(body.error) ? body.error : null;
  return String((err?.message ?? body.message ?? "") as string);
}

function errorCode(body: unknown): string {
  if (!isDict(body)) return "";
  const err = isDict(body.error) ? body.error : body;
  const c = err.code ?? err.type ?? "";
  return typeof c === "string" ? c.toLowerCase() : "";
}

export interface ErrorSource {
  status: number | null;
  message: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** `name` of the thrown error. A transport failure has no status. */
  errorType?: string;
  /** The size of the request, for the "disconnect on a large session" rule. */
  approxTokens?: number;
  contextLength?: number;
}

/** Make an `ErrorSource` from whatever a model call threw. */
export function errorSourceOf(e: unknown): ErrorSource {
  if (e instanceof ProviderHttpError) return { status: e.status, message: e.message, body: e.body, headers: e.headers, errorType: e.name };
  if (e instanceof StreamDroppedError) return { status: null, message: e.message, errorType: e.name };
  if (e instanceof Error) return { status: null, message: e.message, errorType: e.name };
  return { status: null, message: String(e) };
}

/**
 * `classify_api_error`. Stage order: HTTP status, then the structured code, then the
 * message, then the transport type, then `unknown` (retryable with backoff).
 */
export function classifyApiError(src: ErrorSource): ClassifiedError {
  const body = src.body;
  const msg = `${src.message}`.toLowerCase() + (bodyMessage(body) && !src.message.toLowerCase().includes(bodyMessage(body).toLowerCase()) ? ` ${bodyMessage(body).toLowerCase()}` : "");
  const code = errorCode(body);
  const status = src.status;
  const reset = resetDelayFromMessage(msg);

  const byStatus = (): Verdict | null => {
    if (status === null) return null;
    switch (status) {
      case 400: {
        if (has(msg, ROLE_ALTERNATION)) return V.roleAlt;
        if (has(msg, ["invalid tool call arguments", "invalid tool_call arguments", "invalid function call arguments", "invalid function_call arguments", "tool call arguments are invalid", "function call arguments are invalid"])) return V.malformedArgs;
        if (has(msg, PAYLOAD_TOO_LARGE_PATTERNS)) return V.payload;
        if (THINKING_WORDS.some((w) => msg.includes(w)) && msg.includes("thinking")) return V.thinking;
        if (has(msg, REQUEST_VALIDATION) || ["unknown_parameter", "unsupported_parameter"].includes(code)) return V.format;
        if (has(msg, INVALID_MESSAGE_BODY) || code === "invalid_request_body") return V.format;
        if (has(msg, MEMORY_CEILING)) return V.overloaded;
        if (has(msg, EMPTY_RESPONSE)) return V.server;
        if (has(msg, CONTEXT_OVERFLOW_PATTERNS)) return V.overflow;
        if (has(msg, PROVIDER_POLICY)) return V.policy;
        if (has(msg, CONTENT_POLICY)) return V.contentBlocked;
        if (has(msg, MODEL_NOT_FOUND_PATTERNS)) return V.modelNotFound;
        if (has(msg, RATE_LIMIT_PATTERNS)) return V.rate;
        if (has(msg, BILLING_PATTERNS)) return billingHints(msg);
        const generic = bodyMessage(body).trim().length < 30;
        const large = (src.approxTokens ?? 0) > Math.max(0.4 * (src.contextLength ?? 200000), 80000);
        return generic && large ? V.overflow : V.format;
      }
      case 401:
        return V.authRotate;
      case 402:
        return classify402(msg);
      case 403:
        if (has(msg, ["key limit exceeded", "spending limit", ...BILLING_PATTERNS])) return V.billing;
        if (has(msg, UPSTREAM_BLOCKED)) return V.upstreamBlocked;
        return V.authFallback;
      case 404:
        if (BILLING_ERROR_CODES.has(code)) return V.billing;
        if (has(msg, BILLING_PATTERNS)) return V.billing;
        if (has(msg, PROVIDER_POLICY)) return V.policy;
        return has(msg, MODEL_NOT_FOUND_PATTERNS) ? V.modelNotFound : V.unknown;
      case 408:
        return V.timeout;
      case 413:
        return V.payload;
      case 422:
        return V.format;
      case 429: {
        if (BILLING_ERROR_CODES.has(code)) return V.billing;
        if (has(msg, OVERLOADED_PATTERNS)) return V.overloaded;
        const quotaWall = code === "usage_limit_reached" || has(msg, ["usage_limit_reached", ...USAGE_LIMIT_PATTERNS, ...BILLING_PATTERNS]);
        const explicit = has(msg, RATE_LIMIT_PATTERNS);
        if (quotaWall && !explicit && !has(msg, USAGE_LIMIT_TRANSIENT)) return V.billing;
        return reset ? { ...V.rate, errorContext: { reset_at: Date.now() / 1000 + reset } } : V.rate;
      }
      case 500:
      case 502:
        if (has(msg, REQUEST_VALIDATION) || ["unknown_parameter", "unsupported_parameter", "invalid_request_error"].includes(code)) return V.format;
        if (has(msg, EMPTY_RESPONSE)) return V.server;
        if (has(msg, MEMORY_CEILING)) return V.overloaded;
        return has(msg, CONTEXT_OVERFLOW_PATTERNS) ? V.overflow : V.server;
      case 503:
      case 529:
        if (has(msg, EMPTY_RESPONSE)) return V.server;
        if (has(msg, MEMORY_CEILING)) return V.overloaded;
        return has(msg, CONTEXT_OVERFLOW_PATTERNS) ? V.overflow : V.overloaded;
      default:
        return status >= 400 && status < 500 ? V.format : status >= 500 && status < 600 ? V.server : null;
    }
  };
  const byCode = (): Verdict | null => {
    if (["resource_exhausted", "throttled", "rate_limit_exceeded"].includes(code)) return { reason: "rate_limit", shouldRotateCredential: true };
    if (BILLING_ERROR_CODES.has(code)) return V.billing;
    if (["model_not_found", "model_not_available", "invalid_model"].includes(code)) return V.modelNotFound;
    if (["context_length_exceeded", "max_tokens_exceeded"].includes(code)) return V.overflow;
    return null;
  };
  const byMessage = (): Verdict | null => {
    if (has(msg, MEMORY_CEILING)) return V.overloaded;
    if (has(msg, PAYLOAD_TOO_LARGE_PATTERNS)) return V.payload;
    if (has(msg, ROLE_ALTERNATION)) return V.roleAlt;
    if (has(msg, CONTENT_POLICY)) return V.contentBlocked;
    if (has(msg, USAGE_LIMIT_PATTERNS)) return classify402(msg);
    if (has(msg, OVERLOADED_PATTERNS)) return V.overloaded;
    if (has(msg, BILLING_PATTERNS)) return billingHints(msg);
    if (has(msg, RATE_LIMIT_PATTERNS)) return V.rate;
    if (has(msg, EMPTY_RESPONSE)) return V.server;
    if (has(msg, CONTEXT_OVERFLOW_PATTERNS)) return V.overflow;
    if (has(msg, AUTH_PATTERNS)) return V.authRotate;
    if (has(msg, PROVIDER_POLICY)) return V.policy;
    if (has(msg, MODEL_NOT_FOUND_PATTERNS)) return V.modelNotFound;
    if (has(msg, TIMEOUT_PATTERNS) || has(msg, CONNECTION_PATTERNS)) return V.timeout;
    return null;
  };
  const byTransport = (): Verdict | null => {
    if (has(msg, SSL_CERT)) return V.ssl;
    if (has(msg, ["bad record mac", "ssl alert", "tls alert", "ssl handshake failure", "bad_record_mac", "[ssl:"])) return V.timeout;
    if (has(msg, SERVER_DISCONNECT) && !status) {
      const large = (src.approxTokens ?? 0) > Math.max(0.6 * (src.contextLength ?? 200000), 120000);
      return large ? V.overflow : V.timeout;
    }
    const transport = ["TimeoutError", "AbortError", "TypeError", "StreamDroppedError"].includes(src.errorType ?? "");
    return transport ? V.timeout : null;
  };
  const verdict = byStatus() ?? byCode() ?? byMessage() ?? byTransport() ?? V.unknown;
  return {
    statusCode: status,
    message: src.message,
    retryable: true,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
    errorContext: {},
    ...verdict,
  };
}

// ---------------------------------------------------------------- user text

const HOME = "~/.hermes";
const NEXT_STEPS_RETRY = "Wait a minute and send /retry, or switch models with /model.";
const NEXT_STEPS_LOOP =
  "Your message is saved. Send `continue` to try again, or start a new session with /new. If it happens again, run `hermes doctor` and share the error details.";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic", openrouter: "OpenRouter", nous: "Nous Portal", "openai-codex": "OpenAI Codex", openai: "OpenAI", bedrock: "AWS Bedrock",
  gemini: "Google AI Studio", deepseek: "DeepSeek", xai: "xAI", zai: "Z.AI / GLM", custom: "Custom endpoint",
};

/** `hermes_cli/models.py:provider_label`, reduced to a short table. An unknown name is returned as it is. */
export function providerLabel(provider: string | null | undefined): string {
  const original = (provider ?? "openrouter").trim();
  return PROVIDER_LABELS[original.toLowerCase()] ?? (original || "OpenRouter");
}

const EXHAUSTED_LEADS: Record<string, string> = {
  rate_limit: "{label} rate-limited every one of {attempts} attempts",
  upstream_rate_limit: "{label} rate-limited every one of {attempts} attempts",
  overloaded: "{label} reported it was overloaded on all {attempts} attempts",
  server_error: "{label} returned a server error on all {attempts} attempts",
  timeout: "{label} didn't respond in time on any of {attempts} attempts",
};
const EXHAUSTED_DEFAULT_LEAD = "{label} didn't answer after {attempts} attempts";

const NONRETRYABLE_COPY: Record<string, string> = {
  model_not_found: "Model '{model}' isn't available on {label}. Pick a different model with /model (or `hermes model` in a terminal).{prefix_hint}",
  format_error: "{label} rejected this request as malformed, so the model didn't answer. Start a clean session with /new or switch models with /model; if it keeps happening, run `hermes doctor`.",
  role_alternation: "{label} requires user and assistant turns to strictly alternate and rejected this conversation's shape. Start a clean session with /new or switch models with /model.",
  ssl_cert_verification: "Hermes couldn't verify {label}'s security certificate, so the connection was refused. This is usually a corporate proxy or an outdated certificate store on this computer — see the terminal or `{home}/logs/agent.log` for the exact fix, or try another provider with /model.",
  provider_policy_blocked: "{label} refused this request because of a policy on your account (its data/privacy settings, or a block the model's upstream provider placed on the account), so the model didn't answer and retrying won't help. Check the account with the provider, or switch models with /model.",
  upstream_blocked: "A firewall/CDN in front of {label} blocked the request before it reached the model, so your key is probably fine. Set a custom User-Agent via the provider's extra_headers, check the proxy/WAF rules, or switch providers with /model.",
};
const NONRETRYABLE_DEFAULT = "{label} rejected the request and retrying won't help. Pick another model with /model, or check the details in `{home}/logs/agent.log`.";
const AUTH_COPY = {
  oauth: "{label} rejected your sign-in, so the model can't be reached. Sign in again: `{relogin}`.",
  api_key: "{label} rejected your API key, so the model can't be reached. Update it in Settings → Providers, or run `hermes setup` in a terminal.",
};
const CONTENT_POLICY_NEXT_STEPS =
  "That message has been left out of this conversation, so you're not stuck — just ask something else and you can keep going. Rewording it, removing any sensitive attachments, or switching models with /model can also help. If a later message is refused too, start a new chat with /new (in a Bot Chat, Archive it from its tab menu).";

/** Chat copy for the codes a loop site writes itself. `turn_failure_copy.py:_SITE_COPY`. */
const SITE_COPY: Record<string, string> = {
  context_overflow: "This conversation has grown too long for {model} to read, and Hermes couldn't shrink it enough automatically. Start a new session with /new (your history is kept), or try /compress once more. Switching to a model with a bigger context window also works.",
  truncated: "The model's reply was cut off before it finished (it hit its output length limit), so Hermes didn't run the incomplete action. Nothing was changed. Send `continue`, ask for the work in smaller steps, or raise max_tokens for this model.",
  invalid_response: `{label} sent back an empty or broken reply {attempts} times — it is probably overloaded or rate-limiting you. ${NEXT_STEPS_RETRY}\n\nDetails: {detail}`,
  loop_error: `Hermes hit repeated errors and stopped this turn so it wouldn't keep retrying. ${NEXT_STEPS_LOOP}\n\nDetails: {detail}`,
  payload_too_large: "This conversation (including attachments) has grown too large to send to {model}, and Hermes couldn't shrink it enough automatically. Start a new session with /new (your history is kept), or try /compress once more.",
  stream_dropped_tool_call: "The connection to {label} kept dropping while the model was writing a large action, so nothing was run. Check your network and send /retry; asking for the file in smaller pieces also helps.",
  stream_closed_tool_call: "{label} kept closing the stream before the model finished writing its action, without reporting an error, so nothing was run. This is usually the provider or a proxy in front of it cutting long replies short. Send /retry; asking for the work in smaller steps also helps.",
};

function fill(template: string, fields: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => String(fields[k] ?? ""));
}

export function siteCopy(code: string, fields: Record<string, string | number> = {}): string {
  const t = SITE_COPY[code];
  if (!t) throw new Error(`no site copy for ${code}`);
  return fill(t, { home: HOME, ...fields });
}

/** `retry_utils.py:format_reset_window` */
export function formatResetWindow(seconds: number): string {
  const s = Math.trunc(seconds);
  return s >= 3600 ? `~${Math.ceil(s / 3600)}h` : `~${Math.ceil(s / 60)} min`;
}

/** `exhausted_copy`: the text once the retries and the fallbacks are used up. */
export function exhaustedCopy(reason: string, a: { label: string; attempts: number; summary: string; resetSeconds?: number | null }): string {
  const firstAttempt = a.attempts === 1 && (reason === "rate_limit" || reason === "upstream_rate_limit");
  const lead = firstAttempt ? "{label} is rate-limiting requests right now" : (EXHAUSTED_LEADS[reason] ?? EXHAUSTED_DEFAULT_LEAD);
  const rs = a.resetSeconds ?? null;
  const situation =
    rs !== null && (rs >= 120 || (firstAttempt && rs > 0))
      ? `its usage limit resets in ${formatResetWindow(rs)}. Send /retry after that, or switch models with /model.`
      : `it looks temporarily unavailable. ${NEXT_STEPS_RETRY}`;
  return `${fill(lead, { label: a.label, attempts: a.attempts })} — ${situation} To avoid this in future, add a backup provider with \`hermes fallback add\`.\n\nProvider said: ${a.summary}`;
}

/** `nonretryable_copy`: a terminal rejection (auth, model missing, TLS, generic 4xx). */
export function nonretryableCopy(c: Pick<ClassifiedError, "reason">, a: { provider: string; model: string; summary: string; oauth?: boolean; relogin?: string; prefixSuggestion?: string | null }): string {
  const label = providerLabel(a.provider);
  const isAuth = c.reason === "auth" || c.reason === "auth_permanent";
  const template = isAuth ? AUTH_COPY[a.oauth ? "oauth" : "api_key"] : (NONRETRYABLE_COPY[c.reason] ?? NONRETRYABLE_DEFAULT);
  const hint = a.prefixSuggestion ? ` If you typed the name yourself it may be missing its vendor prefix — did you mean '${a.prefixSuggestion}'?` : "";
  const body = fill(template, { label, model: a.model, home: HOME, prefix_hint: hint, relogin: a.relogin ?? `hermes auth add ${a.provider} --type oauth` });
  return `${body}\n\nProvider said: ${a.summary}`;
}

export function contentPolicyCopy(a: { label: string; summary: string }): string {
  return `${a.label}'s safety filter refused this request, so the model didn't answer. ${CONTENT_POLICY_NEXT_STEPS}\n\nProvider said: ${a.summary}`;
}

/** `_summarize_api_error`: a short one-line text for an error. */
export function summarizeApiError(e: ErrorSource): string {
  const raw = e.message;
  if (/temporary failure in name resolution|name or service not known|nodename nor servname provided, or not known|getaddrinfo failed|no address associated with hostname|network is unreachable|getaddrinfo enotfound|fetch failed/i.test(raw)) {
    return "Hermes can't reach the model provider. You may be offline. Check your internet connection and try again.";
  }
  const prefix = e.status ? `HTTP ${e.status}: ` : "";
  if (raw.includes("<!DOCTYPE") || raw.includes("<html")) {
    const t = /<title[^>]*>([^<]+)<\/title>/i.exec(raw);
    const ray = /Cloudflare Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/.exec(raw);
    const parts = prefix ? [prefix.slice(0, -2)] : [];
    parts.push(t ? t[1]!.trim() : "HTML error page (title not found)");
    if (ray) parts.push(`Ray ${ray[1]!.trim()}`);
    return parts.join(" — ");
  }
  const body = e.body;
  if (isDict(body)) {
    const msg = isDict(body.error) ? body.error.message : body.message;
    if (msg) return `${prefix}${String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 300)}`;
  }
  return `${prefix}${raw.slice(0, 500)}`;
}

/** The label of a fallback switch. `chat_completion_helpers.py:_FALLBACK_REASON_LABELS`. */
export const FALLBACK_REASON_LABELS: Partial<Record<FailoverReason, string>> = {
  auth: "authentication failed", auth_permanent: "authentication permanently failed", billing: "billing or quota exhausted", rate_limit: "rate limit",
  upstream_rate_limit: "upstream model rate limit", overloaded: "provider overloaded", server_error: "provider server error", timeout: "request timeout",
  ssl_cert_verification: "TLS certificate verification failed", context_overflow: "context window exceeded", payload_too_large: "request payload too large",
  model_not_found: "model not found", provider_policy_blocked: "provider policy blocked the request",
};

export const fallbackReasonText = (reason: FailoverReason | null): string => (reason && FALLBACK_REASON_LABELS[reason]) || String(reason ?? "provider failure").replaceAll("_", " ");

/** `turn_recovery.py:_eager_fallback_status` */
export function eagerFallbackStatus(c: ClassifiedError, isUpstream: boolean, isTransport: boolean): string {
  if (isUpstream) return `⚠️ Upstream ${String(c.errorContext.upstream_provider ?? "aggregator")} rate-limited — switching to fallback model...`;
  if (c.reason === "billing") {
    return c.errorContext.billing_unverified
      ? "⚠️ Provider reported usage/credit exhaustion (unverified — may be a content-filter rejection) — switching to fallback provider..."
      : "⚠️ Billing or credits exhausted — switching to fallback provider...";
  }
  if (isTransport) return "⚠️ Provider unreachable — switching to fallback provider...";
  return "⚠️ Rate limited — switching to fallback provider...";
}
