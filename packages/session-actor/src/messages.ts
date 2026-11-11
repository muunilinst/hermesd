import type { Sql, SqlRow, SqlValue } from "@hermesd/host";
import { num, str } from "@hermesd/runtime";
import type { ChatMessage, ToolCallWire, Usage } from "./model/openai.ts";
import { PORT_TABLES, type MigrationSet, type PortTable } from "./migrate.ts";

/**
 * Reads and writes of the upstream conversation tables (`sessions`,
 * `messages`, `system_prompts`, `session_model_usage`). The columns are
 * upstream's. The port writes the ones the loop needs and leaves the rest at
 * their defaults.
 */

export interface NewMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  /** The provider's tool calls, as sent. Stored as JSON text, as upstream does. */
  toolCalls?: ToolCallWire[];
  /** For an assistant message: one stable uid for each tool call (upstream `tool_call_uids`). */
  toolCallUids?: string[];
  /** For a tool message: the provider's call id and the stable uid (upstream `tool_call_uid`). */
  toolCallId?: string;
  toolCallUid?: string;
  toolName?: string;
  /** Makes the insert idempotent: a second insert with the same uid in the same session is skipped. */
  messageUid: string;
  finishReason?: string;
  tokenCount?: number;
  compressedSummary?: boolean;
  /**
   * Replay data of an assistant row, in upstream's columns: `reasoning` and
   * `reasoning_content` are text, the other three are JSON lists (stored as
   * JSON text). The provider layer rebuilds signed thinking blocks and
   * Responses reasoning items from them.
   */
  reasoning?: string;
  reasoningContent?: string;
  reasoningDetails?: unknown[];
  codexReasoningItems?: unknown[];
  codexMessageItems?: unknown[];
  /**
   * The ordered content blocks of an Anthropic or Bedrock answer that interleaves
   * signed thinking with tool calls. Upstream keeps them live only; the port rebuilds
   * every request from rows, so it keeps them in the `data` of the answer's
   * `pending_call` (key `replay`), not in a `messages` column.
   */
  orderedBlocks?: { anthropic_content_blocks?: unknown[]; bedrock_content_blocks?: unknown[] };
  /** Set when the row comes from the database. */
  id?: number;
}

const META_CURRENT = "current_session";

/** The session that the actor appends to now. It changes when compaction makes a child session. */
export function currentSessionId(sql: Sql, fallback: string): string {
  const r = sql.exec("SELECT value FROM sa_meta WHERE key = ?", META_CURRENT)[0];
  return r ? str(r.value) : fallback;
}

export function setCurrentSessionId(sql: Sql, id: string): void {
  sql.exec("INSERT OR REPLACE INTO sa_meta (key, value) VALUES (?, ?)", META_CURRENT, id);
}

export interface SessionSeed {
  id: string;
  source: string;
  model: string;
  systemPrompt: string;
  systemPromptHash: string;
  parent?: string;
}

/** Create the session row (and its system prompt) if it does not exist. */
export function ensureSession(sql: Sql, seed: SessionSeed, nowMs: number): void {
  sql.exec("INSERT OR IGNORE INTO system_prompts (hash, prompt) VALUES (?, ?)", seed.systemPromptHash, seed.systemPrompt);
  sql.exec(
    `INSERT OR IGNORE INTO sessions (id, source, model, system_prompt, system_prompt_hash, parent_session_id, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    seed.id,
    seed.source,
    seed.model,
    seed.systemPrompt,
    seed.systemPromptHash,
    seed.parent ?? null,
    nowMs / 1000,
    nowMs / 1000,
  );
}

/** A list column as JSON text, or null when there is nothing to keep (upstream `_reasoning_json_text`). */
function jsonList(v: unknown[] | undefined): string | null {
  return v && v.length > 0 ? JSON.stringify(v) : null;
}

/** A JSON list column back to a list. A value that is not a list is dropped. */
function listOf(v: unknown): unknown[] | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const x = JSON.parse(v) as unknown;
    return Array.isArray(x) && x.length > 0 ? x : undefined;
  } catch {
    return undefined;
  }
}

/** Insert a message. Returns the row id, or undefined if a row with the same uid exists. */
export function insertMessage(sql: Sql, sessionId: string, m: NewMessage, nowMs: number): number | undefined {
  const dup = sql.exec("SELECT id FROM messages WHERE session_id = ? AND message_uid = ?", sessionId, m.messageUid)[0];
  if (dup) return undefined;
  const r = sql.exec(
    `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason,
       message_uid, tool_call_uids, tool_call_uid, _compressed_summary, reasoning, reasoning_content, reasoning_details,
       codex_reasoning_items, codex_message_items)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    sessionId,
    m.role,
    m.content,
    m.toolCallId ?? null,
    m.toolCalls ? JSON.stringify(m.toolCalls) : null,
    m.toolName ?? null,
    nowMs / 1000,
    m.tokenCount ?? null,
    m.finishReason ?? null,
    m.messageUid,
    m.toolCallUids ? JSON.stringify(m.toolCallUids) : null,
    m.toolCallUid ?? null,
    m.compressedSummary ? 1 : 0,
    m.reasoning ? m.reasoning : null,
    m.reasoningContent !== undefined ? m.reasoningContent : null,
    jsonList(m.reasoningDetails),
    jsonList(m.codexReasoningItems),
    jsonList(m.codexMessageItems),
  );
  sql.exec(
    "UPDATE sessions SET message_count = COALESCE(message_count, 0) + 1, tool_call_count = COALESCE(tool_call_count, 0) + ?, last_activity_at = ? WHERE id = ?",
    m.toolCalls?.length ?? 0,
    nowMs / 1000,
    sessionId,
  );
  return num(r[0]!.id);
}

function fromRow(r: SqlRow): NewMessage {
  const m: NewMessage = { id: num(r.id), role: str(r.role) as NewMessage["role"], content: (r.content as string | null) ?? null, messageUid: typeof r.message_uid === "string" ? r.message_uid : `row-${num(r.id)}` };
  if (typeof r.tool_calls === "string") m.toolCalls = JSON.parse(r.tool_calls) as ToolCallWire[];
  if (typeof r.tool_call_uids === "string") m.toolCallUids = JSON.parse(r.tool_call_uids) as string[];
  if (typeof r.tool_call_id === "string") m.toolCallId = r.tool_call_id;
  if (typeof r.tool_call_uid === "string") m.toolCallUid = r.tool_call_uid;
  if (typeof r.tool_name === "string") m.toolName = r.tool_name;
  if (num(r._compressed_summary) === 1) m.compressedSummary = true;
  if (m.role === "assistant") {
    if (typeof r.reasoning === "string" && r.reasoning) m.reasoning = r.reasoning;
    if (typeof r.reasoning_content === "string") m.reasoningContent = r.reasoning_content;
    const details = listOf(r.reasoning_details);
    if (details) m.reasoningDetails = details;
    const codexReasoning = listOf(r.codex_reasoning_items);
    if (codexReasoning) m.codexReasoningItems = codexReasoning;
    const codexMessages = listOf(r.codex_message_items);
    if (codexMessages) m.codexMessageItems = codexMessages;
  }
  return m;
}

/**
 * The lines that go to the model: the active rows of the session, in order.
 * A row from an imported state.db may have no `message_uid`; it gets `row-<id>`.
 */
export function loadActiveMessages(sql: Sql, sessionId: string): NewMessage[] {
  const replay = new Map<string, NonNullable<NewMessage["orderedBlocks"]>>();
  for (const r of sql.exec("SELECT call_id, json_extract(data, '$.replay') AS replay FROM pending_call WHERE json_extract(data, '$.replay') IS NOT NULL")) {
    replay.set(`${str(r.call_id)}:a`, JSON.parse(str(r.replay)) as NonNullable<NewMessage["orderedBlocks"]>);
  }
  const rows = sql
    .exec(
      `SELECT id, role, content, tool_call_id, tool_calls, tool_name, tool_call_uids, tool_call_uid, message_uid, _compressed_summary,
         reasoning, reasoning_content, reasoning_details, codex_reasoning_items, codex_message_items
       FROM messages WHERE session_id = ? AND active = 1 ORDER BY id`,
      sessionId,
    )
    .map(fromRow);
  for (const m of rows) {
    const o = m.role === "assistant" ? replay.get(m.messageUid) : undefined;
    if (o) m.orderedBlocks = o;
  }
  return rows;
}

/** One message in the OpenAI shape. */
export function toApiMessage(m: NewMessage): ChatMessage {
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content,
      ...(m.toolCalls && m.toolCalls.length > 0 ? { tool_calls: m.toolCalls } : {}),
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
      ...(m.reasoningDetails ? { reasoning_details: m.reasoningDetails } : {}),
      ...(m.codexReasoningItems ? { codex_reasoning_items: m.codexReasoningItems } : {}),
      ...(m.codexMessageItems ? { codex_message_items: m.codexMessageItems } : {}),
      ...m.orderedBlocks,
    };
  }
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content ?? "" };
  return { role: "user", content: m.content ?? "" };
}

/** Add one model call to the counters of the session and to `session_model_usage`. */
export function recordUsage(sql: Sql, sessionId: string, model: string, usage: Usage, nowMs: number): void {
  sql.exec(
    `UPDATE sessions SET api_call_count = COALESCE(api_call_count, 0) + 1,
       input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ?,
       cache_read_tokens = COALESCE(cache_read_tokens, 0) + ? WHERE id = ?`,
    usage.promptTokens,
    usage.completionTokens,
    usage.cachedTokens,
    sessionId,
  );
  sql.exec(
    `INSERT INTO session_model_usage (session_id, model, api_call_count, input_tokens, output_tokens, cache_read_tokens, first_seen, last_seen)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, model, billing_provider, billing_base_url, billing_mode, task) DO UPDATE SET
       api_call_count = api_call_count + 1, input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens, cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       last_seen = excluded.last_seen`,
    sessionId,
    model,
    usage.promptTokens,
    usage.completionTokens,
    usage.cachedTokens,
    nowMs / 1000,
    nowMs / 1000,
  );
}

/** Insert a port row with the current schema version. `data` is stored as JSON text. */
export function insertPortRow(
  sql: Sql,
  set: MigrationSet,
  table: PortTable,
  columns: Record<string, SqlValue>,
  data: Record<string, unknown>,
): void {
  if (!PORT_TABLES.includes(table)) throw new Error(`${table} is not a port table`);
  const all: Record<string, SqlValue> = { ...columns, schema_version: set.current, data: JSON.stringify(data) };
  const names = Object.keys(all);
  sql.exec(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, ...names.map((n) => all[n] as SqlValue));
}

/**
 * The replay columns of a new assistant row from a model answer (upstream
 * `chat_completion_helpers.py:_build_assistant_message`). `reasoning` is the
 * reasoning text. `reasoning_content` comes from the provider data, or from the
 * reasoning text when nothing else set it. The three JSON columns are copied as
 * they are, because their signatures and encrypted blobs must come back exactly.
 * `anthropic_content_blocks` and `bedrock_content_blocks` have no column upstream
 * (live only): they go to `orderedBlocks` (see there). `stop_details` is not kept.
 */
export function replayColumns(r: { reasoning?: string | null; providerData?: Record<string, unknown> | null }): Partial<NewMessage> {
  const pd = r.providerData ?? {};
  const out: Partial<NewMessage> = {};
  const list = (v: unknown): unknown[] | undefined => (Array.isArray(v) && v.length > 0 ? v : undefined);
  if (r.reasoning) out.reasoning = r.reasoning;
  if (typeof pd.reasoning_content === "string") out.reasoningContent = pd.reasoning_content;
  else if (r.reasoning) out.reasoningContent = r.reasoning;
  const details = list(pd.reasoning_details);
  if (details) out.reasoningDetails = details;
  const codexReasoning = list(pd.codex_reasoning_items);
  if (codexReasoning) out.codexReasoningItems = codexReasoning;
  const codexMessages = list(pd.codex_message_items);
  if (codexMessages) out.codexMessageItems = codexMessages;
  const anthropic = list(pd.anthropic_content_blocks);
  const bedrock = list(pd.bedrock_content_blocks);
  if (anthropic || bedrock) out.orderedBlocks = { ...(anthropic ? { anthropic_content_blocks: anthropic } : {}), ...(bedrock ? { bedrock_content_blocks: bedrock } : {}) };
  return out;
}
