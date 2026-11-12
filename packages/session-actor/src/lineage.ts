import type { Host, Sql } from "@hermesd/host";
import { assembleCompressed, estimateMessagesTokensRough, isSummaryMessage, staticFallbackSummary } from "@hermesd/prompt";
import { num, str, enqueueOutbox, type Clock, type OutboxWriter } from "@hermesd/runtime";
import { insertMessage, currentSessionId, ensureSession, loadActiveMessages, setCurrentSessionId, type NewMessage } from "./messages.ts";
import { insertPortRow } from "./messages.ts";
import { readPortRows, type MigrationSet } from "./migrate.ts";

/**
 * Compaction lineage (guide 6.4, fault test D7).
 *
 * Compaction makes a child session (`parent_session_id`) and sets `active = 0`
 * on the parent rows that it replaced. Upstream does this in two writes. The
 * port keeps the two commits and records the intent in `compaction_link`, in
 * the commit that writes the child. A crash between the two commits leaves a
 * link with status `started`. `repairLineage` finishes it. It is safe to run
 * any number of times.
 *
 * Rule kept: a tool call and its result are never split. The cut falls before
 * an assistant message whose tool results are not all there. The rows after
 * the cut (the unresolved tail) are copied into the child, in order, after the
 * summary, in the same commit as the child. Upstream also keeps a protected
 * tail. A result that arrives later is written to the child, next to its call.
 * Commit 2 turns every parent row inactive, so no row is active in both sessions.
 */

export interface CompactionDeps {
  host: Host;
  clock: Clock;
  migrations: MigrationSet;
  source: string;
  model: string;
  systemPrompt: string;
  systemPromptHash: string;
  profileTarget: string | null;
}

/** The id of the last message that can be compacted without splitting a tool call from its results. */
export function safeCutoff(sql: Sql, sessionId: string): number {
  const rows = loadActiveMessages(sql, sessionId);
  let end = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]!;
    if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) continue;
    const answered = new Set(rows.slice(i + 1).filter((r) => r.role === "tool").map((r) => r.toolCallId));
    if (m.toolCalls.some((c) => !answered.has(c.id))) end = i;
    break;
  }
  return end === 0 ? 0 : rows[end - 1]!.id!;
}

/**
 * Compact the current session: commit 1 writes the child, commit 2 turns the
 * replaced parent rows inactive. Returns the id of the child session.
 */
export async function compactSession(d: CompactionDeps, summary: string): Promise<string | undefined> {
  const now = d.clock.now();
  const child = await d.host.tx((sql): string | undefined => {
    const parent = currentSessionId(sql, d.host.id());
    const cutoff = safeCutoff(sql, parent);
    if (cutoff === 0) return undefined;
    const n = num(sql.exec("SELECT COUNT(*) AS n FROM compaction_link")[0]!.n) + 1;
    const childId = `${parent}~c${n}`;
    ensureSession(sql, { id: childId, source: d.source, model: d.model, systemPrompt: d.systemPrompt, systemPromptHash: d.systemPromptHash, parent }, now);
    const id = insertMessage(sql, childId, { role: "user", content: summary, messageUid: `${childId}:summary`, compressedSummary: true }, now);
    // The unresolved tail moves to the child with its tool_calls and tool_call_id fields.
    const rows = loadActiveMessages(sql, parent);
    const tail = rows.filter((r) => r.id! > cutoff);
    for (const r of tail) {
      const { id: _parentRowId, ...copy } = r;
      insertMessage(sql, childId, copy, now);
    }
    // The tail is copied, so commit 2 retires every parent row up to the last one.
    const lastId = rows[rows.length - 1]!.id!;
    insertPortRow(sql, d.migrations, "compaction_link", { child_id: childId, parent_id: parent, cutoff_message_id: lastId, status: "started" }, { summary_message_id: id ?? null, replaced_up_to: cutoff, tail: tail.length });
    setCurrentSessionId(sql, childId);
    if (d.profileTarget) enqueueOutbox(sql, now, d.profileTarget, "session_upsert", { sessionId: childId, parent, status: "compacted-child" });
    return childId;
  });
  await d.host.commit();
  if (child === undefined) return undefined;
  await finishCompaction(d);
  return child;
}

/** Commit 2: the parent rows that the child replaced become inactive and compacted. */
export async function finishCompaction(d: Pick<CompactionDeps, "host" | "clock" | "migrations">): Promise<number> {
  const now = d.clock.now();
  const n = await d.host.tx((sql) => repairLineageRows(sql, d.migrations, now));
  await d.host.commit();
  return n;
}

/** The writes of commit 2, for every link that is still `started`. Call it inside a transaction. */
export function repairLineageRows(sql: Sql, migrations: MigrationSet, nowMs: number): number {
  const links = readPortRows(sql, migrations, "compaction_link", "status = 'started'");
  for (const l of links) {
    const parent = str(l.row.parent_id);
    const cutoff = num(l.row.cutoff_message_id);
    sql.exec("UPDATE messages SET active = 0, compacted = 1 WHERE session_id = ? AND id <= ? AND active = 1", parent, cutoff);
    sql.exec("UPDATE sessions SET ended_at = ?, end_reason = 'compression' WHERE id = ? AND ended_at IS NULL", nowMs / 1000, parent);
    sql.exec("UPDATE compaction_link SET status = 'done' WHERE child_id = ?", str(l.row.child_id));
  }
  return links.length;
}

/**
 * The invariant of D7: no parent row that a child replaced is still active
 * once the link is done, and no link is left `started`. Returns the problems.
 */
export function checkLineage(sql: Sql): string[] {
  const problems: string[] = [];
  for (const l of sql.exec("SELECT child_id, parent_id, cutoff_message_id, status FROM compaction_link")) {
    const still = num(
      sql.exec("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND id <= ? AND active = 1", str(l.parent_id), num(l.cutoff_message_id))[0]!.n,
    );
    if (str(l.status) === "done" && still > 0) problems.push(`${str(l.parent_id)} has ${still} active rows that ${str(l.child_id)} replaced`);
    if (str(l.status) === "started") problems.push(`link to ${str(l.child_id)} is not finished`);
  }
  return problems;
}

// ---------------------------------------------------------------- compaction of a window

/** The meta key that holds the child session whose compaction has not been judged yet. */
export const VERDICT_PENDING = "compression_verdict_pending";

export interface WindowChildInput {
  /** The uids of the rows before the cut, in order (the protected head). */
  headUids: readonly string[];
  /** The uids of the rows that the summary replaces, in order. */
  middleUids: readonly string[];
  /** The handoff text (with the prefix), or a reason to build the static fallback. */
  summary: { text: string } | { fallbackReason: string };
  tokensBefore: number;
  reason: string;
  turnId: string;
}

export interface WindowChildDeps {
  migrations: MigrationSet;
  source: string;
  model: string;
  systemPrompt: string;
  systemPromptHash: string;
  profileTarget: string | null;
  /** The session id to use when no current session is recorded yet. */
  fallbackId: string;
}

export interface WindowChildResult {
  childId: string;
  tokensAfter: number;
  fallback: boolean;
}

/**
 * Compaction of a window (upstream `compress()` phase 4 and the rotation in
 * `hermes_state_compression.py:_publish_compression_child_on_conn`). The child
 * session gets the head, the summary row and the tail. The parent keeps its rows
 * until commit 2 (`repairLineageRows`) turns every parent row up to the
 * cutoff inactive, as in D7. Call it inside a transaction. Returns undefined
 * if the rows are not what the plan saw: nothing is written then.
 *
 * It does not commit. The caller writes it in the same commit as the end of the
 * summary call, so a summary is used once.
 */
export function writeWindowChild(
  sql: Sql,
  d: WindowChildDeps,
  outbox: OutboxWriter,
  input: WindowChildInput,
  nowMs: number,
): WindowChildResult | undefined {
  const parent = currentSessionId(sql, d.fallbackId);
  const rows = loadActiveMessages(sql, parent);
  const start = input.headUids.length;
  const end = start + input.middleUids.length;
  if (rows.length <= end) return undefined;
  const same = (uids: readonly string[], from: number): boolean => uids.every((u, i) => rows[from + i]?.messageUid === u);
  if (!same(input.headUids, 0) || !same(input.middleUids, start)) return undefined;
  const middle = rows.slice(start, end);
  const turns = middle.filter((m) => !isSummaryMessage(m));
  const prevRow = [...middle].reverse().find(isSummaryMessage);
  let summaryText: string;
  let fallback = false;
  if ("text" in input.summary) summaryText = input.summary.text;
  else {
    fallback = true;
    summaryText = staticFallbackSummary(turns, { reason: input.summary.fallbackReason, ...(prevRow?.content ? { previousSummary: prevRow.content } : {}) });
  }
  const assembled = assembleCompressed(rows, { start, end }, summaryText);
  const n = num(sql.exec("SELECT COUNT(*) AS n FROM compaction_link")[0]!.n) + 1;
  const childId = `${parent}~c${n}`;
  const cutoff = rows[rows.length - 1]!.id!;
  ensureSession(sql, { id: childId, source: d.source, model: d.model, systemPrompt: d.systemPrompt, systemPromptHash: d.systemPromptHash, parent }, nowMs);
  let summaryId: number | undefined;
  const childRows: NewMessage[] = [];
  for (const a of assembled) {
    let m: NewMessage;
    if (a.source) {
      if (a.summary) {
        // The summary is merged into this row: Codex message items and ordered blocks hold the old text.
        const { codexMessageItems: _m, orderedBlocks: _o, ...rest } = a.source;
        m = { ...rest, content: a.content, compressedSummary: true };
      } else m = { ...a.source, content: a.content };
    } else {
      m = { role: a.role as NewMessage["role"], content: a.content, messageUid: `${childId}:summary`, compressedSummary: true };
    }
    childRows.push(m);
    const id = insertMessage(sql, childId, m, nowMs);
    if (a.summary && summaryId === undefined) summaryId = id;
  }
  const tokensAfter = estimateMessagesTokensRough(childRows);
  const carried = num(sql.exec("SELECT COALESCE(compression_ineffective_count, 0) AS c FROM sessions WHERE id = ?", parent)[0]?.c ?? 0);
  sql.exec("UPDATE sessions SET compression_ineffective_count = ? WHERE id = ?", carried, childId);
  insertPortRow(
    sql,
    d.migrations,
    "compaction_link",
    { child_id: childId, parent_id: parent, cutoff_message_id: cutoff, status: "started" },
    {
      kind: "window",
      summary_message_id: summaryId ?? null,
      reason: input.reason,
      turn_id: input.turnId,
      tokens_before: input.tokensBefore,
      tokens_after: tokensAfter,
      fallback,
      head: input.headUids.length,
      middle: input.middleUids.length,
      tail: rows.length - end,
    },
  );
  setCurrentSessionId(sql, childId);
  sql.exec("INSERT OR REPLACE INTO sa_meta (key, value) VALUES (?, ?)", VERDICT_PENDING, childId);
  if (d.profileTarget) outbox.enqueue(d.profileTarget, "session_upsert", { sessionId: childId, parent, status: "compacted-child" });
  return { childId, tokensAfter, fallback };
}
