/**
 * The OpenAI chat_completions wire format, the one provider of milestone 1.
 * The loop builds the request body once, stores it in `pending_call`, and a
 * retry sends the same bytes with the same `idempotency-key`.
 */

export interface ToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallWire[];
  tool_call_id?: string;
  /**
   * The replay columns of an assistant row (upstream `messages.reasoning` and
   * friends). The provider layer reads them to rebuild thinking blocks and
   * reasoning items. Only set when the row has them.
   */
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: unknown[];
  codex_reasoning_items?: unknown[];
  codex_message_items?: unknown[];
  anthropic_content_blocks?: unknown[];
  bedrock_content_blocks?: unknown[];
}

export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ParsedResponse {
  content: string | null;
  toolCalls: ToolCallWire[];
  finishReason: string | null;
  usage: Usage;
  /** The reasoning text of the answer, when the provider layer gave one. */
  reasoning?: string | null;
  /** Carrier fields of the provider layer (`reasoning_details`, `codex_reasoning_items`, ...). */
  providerData?: Record<string, unknown> | null;
}

/** The request for one model call. The call ID is the idempotency key. */
export function chatRequest(url: string, body: string, callId: string, apiKey?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": callId,
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
  });
}

/** Read a chat_completions answer. Returns a string when the body is not an answer. */
export function parseChatResponse(json: unknown): ParsedResponse | string {
  if (typeof json !== "object" || json === null) return "the model answer is not an object";
  const o = json as { choices?: unknown; usage?: Record<string, unknown> };
  if (!Array.isArray(o.choices) || o.choices.length === 0) return "the model answer has no choices";
  const choice = o.choices[0] as { message?: Record<string, unknown>; finish_reason?: unknown };
  const m = choice.message;
  if (typeof m !== "object" || m === null) return "the first choice has no message";
  const calls = Array.isArray(m.tool_calls) ? (m.tool_calls as ToolCallWire[]) : [];
  for (const c of calls) {
    if (typeof c?.id !== "string" || typeof c.function?.name !== "string" || typeof c.function.arguments !== "string") {
      return "a tool call in the model answer is malformed";
    }
  }
  const u = o.usage ?? {};
  const details = (u.prompt_tokens_details ?? {}) as { cached_tokens?: unknown };
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  // The reasoning fields, as the provider layer reads them (providers/src/chat.ts), so the row keeps them.
  const providerData: Record<string, unknown> = {};
  if (m.reasoning_content !== undefined && m.reasoning_content !== null) providerData.reasoning_content = m.reasoning_content;
  if (Array.isArray(m.reasoning_details) && m.reasoning_details.length > 0) providerData.reasoning_details = m.reasoning_details;
  const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    content: typeof m.content === "string" ? m.content : null,
    toolCalls: calls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: { promptTokens: n(u.prompt_tokens), completionTokens: n(u.completion_tokens), cachedTokens: n(details.cached_tokens) },
    reasoning: text(m.reasoning) ?? text(m.reasoning_content),
    providerData: Object.keys(providerData).length > 0 ? providerData : null,
  };
}

/**
 * The bytes of a chat_completions request without a model client. An assistant
 * message keeps the reasoning keys a chat_completions host reads back
 * (`reasoning_content`, `reasoning_details`); the keys for other API modes are dropped.
 */
export function chatBody(body: ChatRequestBody): string {
  const messages = body.messages.map(
    ({ reasoning: _r, codex_reasoning_items: _c, codex_message_items: _m, anthropic_content_blocks: _a, bedrock_content_blocks: _b, ...rest }) => rest,
  );
  return JSON.stringify({ ...body, messages });
}

/** A rough size of a request in tokens: 4 characters for one token, as a safety estimate. */
export function estimateTokens(body: { messages: ChatMessage[]; tools?: unknown[] }): number {
  return Math.ceil(JSON.stringify(body).length / 4);
}
