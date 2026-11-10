import type { Host, Sql } from "@hermesd/host";
import { num, str, enqueueOutbox, type Clock } from "@hermesd/runtime";
import { insertMessage, currentSessionId, ensureSession, loadActiveMessages, setCurrentSessionId } from "./messages.ts";
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
 * an assistant message whose tool results are not all there.
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
    insertPortRow(sql, d.migrations, "compaction_link", { child_id: childId, parent_id: parent, cutoff_message_id: cutoff, status: "started" }, { summary_message_id: id ?? null });
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
