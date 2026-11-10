import type { Sql } from "@hermesd/host";
import { SESSION_UPSTREAM_DDL } from "./upstream-ddl.ts";

/**
 * The tables of one session actor.
 *
 * - The four upstream tables are created from upstream's own statements.
 * - The port adds `pending_call` and `pending_op` (guide 6.3) and three small
 *   tables for the tools: `clarify_question`, `todo_item`. `loop_turn` holds
 *   the position of the loop. `compaction_link` records a child session.
 * - Every port row has `schema_version` and a JSON `data` column (guide 7.4).
 *   Columns are for what the code looks up. Everything else is in `data`.
 */

export const PORT_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS sa_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  // One model call that may be in flight. Keyed by call_id. A retry reuses the call_id and the request.
  `CREATE TABLE IF NOT EXISTS pending_call (
    call_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
    request TEXT NOT NULL,
    response_digest TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,

  // One tool operation. Keyed by op_id = H(tenant, session, tool_call_uid). The incarnation is fixed once.
  `CREATE TABLE IF NOT EXISTS pending_op (
    op_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    tool_call_uid TEXT NOT NULL UNIQUE,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    incarnation INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'cancelled', 'unknown')),
    discard INTEGER NOT NULL DEFAULT 0,
    acked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,

  // A question for the user. The wait survives a restart because it is a row.
  `CREATE TABLE IF NOT EXISTS clarify_question (
    tool_call_uid TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'answered')),
    created_at INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS todo_item (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,

  // The position of the loop inside a turn.
  `CREATE TABLE IF NOT EXISTS loop_turn (
    turn_id TEXT PRIMARY KEY,
    interrupted INTEGER NOT NULL DEFAULT 0,
    model_calls INTEGER NOT NULL DEFAULT 0,
    schema_version INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,

  // A child session made by compaction. See lineage.ts.
  `CREATE TABLE IF NOT EXISTS compaction_link (
    child_id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    cutoff_message_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'done')),
    schema_version INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
];

/** Create all tables of the session actor. Safe to run at every activation. */
export function applySessionSchema(sql: Sql): void {
  for (const ddl of Object.values(SESSION_UPSTREAM_DDL)) sql.exec(ddl);
  for (const ddl of PORT_DDL) sql.exec(ddl);
  sql.exec("CREATE INDEX IF NOT EXISTS sa_messages_session ON messages (session_id, id)");
}
