/**
 * The token estimator.
 *
 * Port of upstream `agent/model_metadata.py`: `estimate_tokens_rough`,
 * `estimate_messages_tokens_rough`, `estimate_request_tokens_rough`, and of
 * `agent/context_compressor.py`: `_estimate_msg_budget_tokens`.
 *
 * Upstream does NOT use a tokenizer library here. It uses a fixed rule: one
 * token for each CJK character, and one token for each 4 UTF-8 bytes of all
 * other text (rounded up). So no fallback was needed. This is the real
 * algorithm.
 *
 * Differences: Python takes `str(message_dict)` as the text of a message. The
 * port takes the JSON of the message in the wire shape. The size differs by a
 * few characters for each key. Images are not counted (the port has none).
 */

export const CHARS_PER_TOKEN = 4;

// Upstream _CJK_DENSE_RE.
const CJK_DENSE = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-힯豈-﫿＀-￯]/gu;
const ENCODER = new TextEncoder();

/** A message that the estimator can read. */
export interface EstimatedMessage {
  role: string;
  content?: string | null;
  toolCalls?: ReadonlyArray<unknown> | undefined;
  toolCallId?: string | undefined;
}

/** Upstream `estimate_tokens_rough`. */
export function estimateTokensRough(text: string): number {
  if (!text) return 0;
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007f]*$/.test(text)) return Math.floor((text.length + 3) / CHARS_PER_TOKEN);
  let dense = 0;
  const stripped = text.replace(CJK_DENSE, () => {
    dense += 1;
    return "";
  });
  return dense + Math.floor((ENCODER.encode(stripped).length + 3) / CHARS_PER_TOKEN);
}

/** The message as the provider receives it (OpenAI chat shape). */
function wireShadow(m: EstimatedMessage): Record<string, unknown> {
  const shadow: Record<string, unknown> = { role: m.role, content: m.content ?? null };
  if (m.toolCalls && m.toolCalls.length > 0) shadow.tool_calls = m.toolCalls;
  if (m.toolCallId !== undefined) shadow.tool_call_id = m.toolCallId;
  return shadow;
}

/** Upstream `_estimate_message_tokens_without_images`: the estimate for one message. */
export function estimateMessageTokens(m: EstimatedMessage): number {
  return estimateTokensRough(JSON.stringify(wireShadow(m)));
}

/** Upstream `estimate_messages_tokens_rough`. */
export function estimateMessagesTokensRough(messages: readonly EstimatedMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/** Upstream `estimate_request_tokens_rough`: system prompt, messages and tool schemas. */
export function estimateRequestTokensRough(messages: readonly EstimatedMessage[], opts: { systemPrompt?: string; tools?: readonly unknown[] } = {}): number {
  let total = opts.systemPrompt ? estimateTokensRough(opts.systemPrompt) : 0;
  total += estimateMessagesTokensRough(messages);
  if (opts.tools && opts.tools.length > 0) total += estimateTokensRough(JSON.stringify(opts.tools));
  return total;
}

/**
 * Upstream `_estimate_msg_budget_tokens`: the size of one message in the tail
 * budget walks. Content, plus 10 for role and key overhead, plus the full
 * tool-call envelopes. Thinking fields are not in the port.
 */
export function messageBudgetTokens(m: EstimatedMessage): number {
  let tokens = estimateTokensRough(m.content ?? "") + 10;
  for (const tc of m.toolCalls ?? []) if (typeof tc === "object" && tc !== null) tokens += estimateTokensRough(JSON.stringify(tc));
  return tokens;
}
