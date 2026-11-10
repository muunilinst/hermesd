import { buildAnthropicBody, anthropicHeaders, parseAnthropicResponse, readAnthropicStream } from "./anthropic.ts";
import { type RequestSigner, bearerSigner, buildConverseRequest, converseUrl, decodeEventStream, normalizeConverseStreamEvents, parseConverseResponse } from "./bedrock.ts";
import { buildChatBody, parseChatResponse, readChatStream } from "./chat.ts";
import { buildCodexBody, parseCodexResponse, readCodexStream } from "./codex.ts";
import { ProviderHttpError, headersToRecord } from "./sse.ts";
import type { ApiMode, Dict, FetchFn, ModelCallInput, NormalizedResponse, RequestOptions } from "./types.ts";

/**
 * The `ModelClient` seam: one object per API mode that builds the request body
 * and sends it. The loop builds the body once, stores it in `pending_call.request`,
 * and sends the same bytes again on a retry, with the same `idempotency-key`
 * (guide 6.3). So `buildBody` is pure and `send` takes the stored bytes.
 *
 * `send` returns the normalized answer, or throws:
 * - `ProviderHttpError` for a non-2xx status (the loop treats 429, 408 and 5xx as "wait").
 * - `StreamDroppedError` when a stream ends or breaks before its terminal event. The partial
 *   output is dropped with the stack frame; the loop sends the stored request again.
 * - `MalformedResponseError` when the answer is 2xx but is not a valid answer.
 * - An `AbortError` when the signal fires (an interrupt).
 * - Any other error is a transport failure (no status).
 */

export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

export interface SendContext {
  /** The call id. It goes out as the `idempotency-key` header. */
  callId: string;
  fetch: FetchFn;
  signal?: AbortSignal;
  /** The API key for this try. A router gives a rotated key here. */
  apiKey?: string;
}

export interface SendResult {
  response: NormalizedResponse;
  /** The raw text of the answer (the JSON body, or the joined stream data). The loop hashes it. */
  raw: string;
}

export interface ModelClient {
  readonly mode: ApiMode;
  readonly model: string;
  readonly stream: boolean;
  /** The request body as bytes. Pure: the same input gives the same bytes. */
  buildBody(input: Omit<ModelCallInput, "model"> & { model?: string }): string;
  send(body: string, ctx: SendContext): Promise<SendResult>;
}

export interface ClientConfig {
  model: string;
  /** The full endpoint URL. Each mode has a default (see below). */
  url?: string;
  /** Ask for a streamed answer. Default false. */
  stream?: boolean;
  apiKey?: string;
  /** Default request options. The options of a `buildBody` call win. */
  options?: RequestOptions;
}

export interface BedrockClientConfig extends ClientConfig {
  region?: string;
  /** A SigV4 signer. Without one, `apiKey` is used as a bearer token. */
  signer?: RequestSigner;
}

export const DEFAULT_URLS: Record<Exclude<ApiMode, "bedrock_converse">, string> = {
  chat_completions: "https://api.openai.com/v1/chat/completions",
  anthropic_messages: "https://api.anthropic.com/v1/messages",
  codex_responses: "https://api.openai.com/v1/responses",
};

function mergeOptions(cfg: ClientConfig, input: Omit<ModelCallInput, "model">, url: string | undefined): RequestOptions {
  return { baseUrl: url ?? null, ...cfg.options, ...input.options, stream: cfg.stream ?? false };
}

async function failIfError(res: Response): Promise<void> {
  if (res.ok) return;
  throw new ProviderHttpError(res.status, await res.text(), headersToRecord(res.headers));
}

const isJson = (res: Response): boolean => (res.headers.get("content-type") ?? "").includes("application/json");

function request(url: string, headers: Record<string, string>, body: string, ctx: SendContext): Request {
  return new Request(url, { method: "POST", headers: { ...headers, "idempotency-key": ctx.callId }, body });
}

/** Parse a JSON answer with one of the string-or-response parsers. */
function parseJsonAnswer(text: string, parse: (json: unknown) => NormalizedResponse | string): NormalizedResponse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MalformedResponseError("the model answer is not JSON");
  }
  const r = parse(json);
  if (typeof r === "string") throw new MalformedResponseError(r);
  return r;
}

function guard<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof Error && e.name === "StreamDroppedError") throw e;
    throw new MalformedResponseError(e instanceof Error ? e.message : String(e));
  }
}

/** `transports/chat_completions.py` + the OpenAI SDK call. */
export function chatCompletionsClient(cfg: ClientConfig): ModelClient {
  const url = cfg.url ?? DEFAULT_URLS.chat_completions;
  return {
    mode: "chat_completions",
    model: cfg.model,
    stream: cfg.stream ?? false,
    buildBody: (input) => buildChatBody({ ...input, model: cfg.model, options: mergeOptions(cfg, input, url) }),
    async send(body, ctx) {
      const key = ctx.apiKey ?? cfg.apiKey;
      const res = await ctx.fetch(request(url, { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body, ctx), ctx.signal);
      await failIfError(res);
      if (cfg.stream && !isJson(res)) {
        const { response, raw } = await readChatStream(res.body);
        return { response: guard(() => parseJsonAnswer(JSON.stringify(response), parseChatResponse)), raw };
      }
      const text = await res.text();
      return { response: parseJsonAnswer(text, parseChatResponse), raw: text };
    },
  };
}

/** `transports/anthropic.py` + the Anthropic SDK call. */
export function anthropicMessagesClient(cfg: ClientConfig): ModelClient {
  const url = cfg.url ?? DEFAULT_URLS.anthropic_messages;
  return {
    mode: "anthropic_messages",
    model: cfg.model,
    stream: cfg.stream ?? false,
    buildBody: (input) => buildAnthropicBody({ ...input, model: cfg.model, options: mergeOptions(cfg, input, url) }),
    async send(body, ctx) {
      const res = await ctx.fetch(request(url, anthropicHeaders(ctx.apiKey ?? cfg.apiKey, url), body, ctx), ctx.signal);
      await failIfError(res);
      if (cfg.stream && !isJson(res)) {
        const { response, raw } = await readAnthropicStream(res.body);
        return { response: parseJsonAnswer(JSON.stringify(response), parseAnthropicResponse), raw };
      }
      const text = await res.text();
      return { response: parseJsonAnswer(text, parseAnthropicResponse), raw: text };
    },
  };
}

/** `transports/codex.py` + the Responses call. */
export function codexResponsesClient(cfg: ClientConfig): ModelClient {
  const url = cfg.url ?? DEFAULT_URLS.codex_responses;
  const issuerKind = cfg.options?.issuerKind ?? null;
  const parse = (json: unknown): NormalizedResponse | string => {
    try {
      return parseCodexResponse(json, issuerKind, cfg.model);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  return {
    mode: "codex_responses",
    model: cfg.model,
    stream: cfg.stream ?? false,
    buildBody: (input) => buildCodexBody({ ...input, model: cfg.model, options: mergeOptions(cfg, input, url) }),
    async send(body, ctx) {
      const key = ctx.apiKey ?? cfg.apiKey;
      const res = await ctx.fetch(request(url, { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body, ctx), ctx.signal);
      await failIfError(res);
      if (cfg.stream && !isJson(res)) {
        const { response, raw } = await readCodexStream(res.body);
        return { response: parseJsonAnswer(JSON.stringify(response), parse), raw };
      }
      const text = await res.text();
      return { response: parseJsonAnswer(text, parse), raw: text };
    },
  };
}

/** `bedrock_adapter.py`, over the REST API. The model id is in the URL path. */
export function bedrockConverseClient(cfg: BedrockClientConfig): ModelClient {
  const region = cfg.region ?? cfg.options?.region ?? "us-east-1";
  const stream = cfg.stream ?? false;
  const url = converseUrl(cfg.model, region, stream, cfg.url ?? null);
  return {
    mode: "bedrock_converse",
    model: cfg.model,
    stream,
    buildBody: (input) => buildConverseRequest({ ...input, model: cfg.model, options: { ...mergeOptions(cfg, input, undefined), region } }).body,
    async send(body, ctx) {
      const headers: Record<string, string> = { "content-type": "application/json", accept: stream ? "application/vnd.amazon.eventstream" : "application/json", "idempotency-key": ctx.callId };
      const key = ctx.apiKey ?? cfg.apiKey;
      const signer = cfg.signer ?? (key ? bearerSigner(key) : undefined);
      if (signer) Object.assign(headers, await signer.sign({ method: "POST", url, headers, body, region, service: "bedrock" }));
      const res = await ctx.fetch(new Request(url, { method: "POST", headers, body }), ctx.signal);
      await failIfError(res);
      if (stream && !isJson(res)) {
        const events: Dict[] = [];
        for await (const ev of decodeEventStream(res.body)) events.push(ev);
        const response = guard(() => normalizeConverseStreamEvents(events));
        return { response, raw: events.map((e) => JSON.stringify(e)).join("\n") };
      }
      const text = await res.text();
      return { response: parseJsonAnswer(text, parseConverseResponse), raw: text };
    },
  };
}

export function createModelClient(mode: ApiMode, cfg: BedrockClientConfig): ModelClient {
  switch (mode) {
    case "chat_completions":
      return chatCompletionsClient(cfg);
    case "anthropic_messages":
      return anthropicMessagesClient(cfg);
    case "codex_responses":
      return codexResponsesClient(cfg);
    case "bedrock_converse":
      return bedrockConverseClient(cfg);
  }
}
