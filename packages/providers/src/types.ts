/**
 * Shared types of the provider layer.
 *
 * A message is an upstream `messages` row in the OpenAI shape: `role`,
 * `content`, `tool_calls`, `tool_call_id`, plus the optional carrier columns
 * that upstream keeps for replay (`reasoning_details`, `anthropic_content_blocks`,
 * `bedrock_content_blocks`, `codex_reasoning_items`, `codex_message_items`).
 * Wire shapes are open JSON, so they use `Dict`.
 */

export type Dict = Record<string, any>;

export type ApiMode = "chat_completions" | "anthropic_messages" | "codex_responses" | "bedrock_converse";

export const API_MODES: readonly ApiMode[] = ["chat_completions", "anthropic_messages", "codex_responses", "bedrock_converse"];

/** One tool call in the OpenAI shape. `call_id` and `response_item_id` are the Codex extras. */
export interface ToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  call_id?: string;
  response_item_id?: string;
  extra_content?: unknown;
}

/** An upstream `messages` row, as the converters read it. */
export interface Message extends Dict {
  role: string;
  content?: unknown;
  tool_calls?: ToolCallWire[];
  tool_call_id?: string;
}

/** An OpenAI tool definition: `{type: "function", function: {name, description, parameters}}`. */
export interface ToolDefinition extends Dict {
  type?: string;
  function: { name: string; description?: string; parameters?: Dict; strict?: boolean };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

/**
 * The answer of one model call, in one shape for every mode.
 * Upstream: `agent/transports/types.py:NormalizedResponse`.
 */
export interface NormalizedResponse {
  content: string | null;
  toolCalls: ToolCallWire[];
  /** `stop`, `tool_calls`, `length`, `content_filter` or `incomplete`. */
  finishReason: string;
  reasoning: string | null;
  usage: Usage;
  /** Carrier fields that go into the assistant row: `reasoning_details`, `anthropic_content_blocks`, and so on. */
  providerData: Dict | null;
}

/** Options that change the request body. All are optional. */
export interface RequestOptions {
  /** `{effort, enabled}`, upstream `reasoning_config`. */
  reasoningConfig?: { effort?: string; enabled?: boolean } | null;
  maxTokens?: number | null;
  temperature?: number | null;
  /** The base URL of the endpoint. It selects some quirks (thinking replay, cache key). */
  baseUrl?: string | null;
  /** Ask for a streamed answer. */
  stream?: boolean;
  sessionId?: string | null;
  toolChoice?: string | null;
  /** chat_completions: the name of the output limit field. Default `max_tokens`. */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Fields merged into the end of the body (upstream `request_overrides` / `extra_body`). */
  extraBody?: Dict;
  /** Bedrock: the AWS region. Default `us-east-1`. */
  region?: string;
  /** Bedrock: a guardrail config. */
  guardrailConfig?: Dict | null;
  /** codex_responses: the issuer kind (`codex_backend`, `xai_responses`, or null). */
  issuerKind?: string | null;
}

export interface ModelCallInput {
  model: string;
  /** The full list, system message first (upstream `api_messages`). */
  messages: Message[];
  tools: ToolDefinition[];
  options?: RequestOptions;
}

export type FetchFn = (req: Request, signal?: AbortSignal) => Promise<Response>;

/** Python-style helpers the converters share. */
export function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function nonBlank(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Python truthiness for the values that appear in wire JSON. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}
