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
  return {
    content: typeof m.content === "string" ? m.content : null,
    toolCalls: calls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: { promptTokens: n(u.prompt_tokens), completionTokens: n(u.completion_tokens), cachedTokens: n(details.cached_tokens) },
  };
}

/** A rough size of a request in tokens: 4 characters for one token, as a safety estimate. */
export function estimateTokens(body: { messages: ChatMessage[]; tools?: unknown[] }): number {
  return Math.ceil(JSON.stringify(body).length / 4);
}
