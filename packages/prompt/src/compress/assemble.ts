import { MERGED_PRIOR_CONTEXT_HEADER, MERGED_SUMMARY_DELIMITER, SUMMARY_END_MARKER } from "./upstream-text.ts";
import type { CompressionWindow } from "./window.ts";

/**
 * The messages after compression: head, then the summary, then tail.
 *
 * Port of upstream `agent/context_compressor.py`: `_summary_placement`,
 * `_merge_summary_into_tail_row`, `_assemble_compressed`, `_sanitize_tool_pairs`
 * and `_template_visible_role`.
 *
 * The result lists each row of the new transcript. A row with a `source` is a
 * kept message (its content may have the summary merged in). The row without
 * a source is the summary row.
 */

export interface AssembleMessage {
  role: string;
  content?: string | null;
  toolCalls?: ReadonlyArray<{ id: string }> | undefined;
  toolCallId?: string | undefined;
}

export interface AssembledRow<M> {
  /** The kept message, or undefined for the standalone summary row. */
  source: M | undefined;
  role: string;
  content: string;
  /** The row holds the summary (standalone, or merged into a kept row). */
  summary: boolean;
}

/** Upstream `_template_visible_role`: the role as strict chat templates count it for alternation. */
function visibleRole(m: AssembleMessage): string | null {
  if (m.role === "tool") return null;
  if (m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0) return null;
  return m.role;
}

/** Upstream `_last_template_visible_role`. */
function lastVisibleRole(rows: readonly AssembleMessage[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = visibleRole(rows[i]!);
    if (r !== null) return r;
  }
  return null;
}

export interface Placement {
  role: "user" | "assistant";
  mergeIntoTail: boolean;
  forceUserLeading: boolean;
  firstTailVisibleIdx: number | null;
}

/** Upstream `_summary_placement`: the role of the summary row, so that roles alternate. */
export function summaryPlacement(head: readonly AssembleMessage[], tail: readonly AssembleMessage[], compressStart: number): Placement {
  const lastHeadRole: string | null = head.length > 0 ? lastVisibleRole(head) : "user";
  let firstTailVisibleIdx: number | null = null;
  let firstTailRole: string | null = null;
  for (let i = 0; i < tail.length; i++) {
    const r = visibleRole(tail[i]!);
    if (r !== null) {
      firstTailVisibleIdx = i;
      firstTailRole = r;
      break;
    }
  }
  // A head with no user text, or no head: the summary opens the visible sequence and must be a user message.
  const forceUserLeading =
    compressStart === 0 ||
    lastHeadRole === "system" ||
    ![...head, ...tail].some((m) => m.role === "user" && (m.content ?? "").trim() !== "");
  let role: "user" | "assistant" = lastHeadRole === null || lastHeadRole === "assistant" || lastHeadRole === "tool" || forceUserLeading ? "user" : "assistant";
  let mergeIntoTail = false;
  if (firstTailRole !== null && role === firstTailRole) {
    const flipped = role === "user" ? "assistant" : "user";
    if (flipped !== lastHeadRole && lastHeadRole !== null && !forceUserLeading) role = flipped;
    else mergeIntoTail = tail.length > 0;
  }
  return { role, mergeIntoTail, forceUserLeading, firstTailVisibleIdx };
}

/** Upstream `_sanitize_tool_pairs`: no result without its call, no call without its result (except the in-flight turn). */
export function sanitizeToolPairs<M extends AssembleMessage>(rows: AssembledRow<M>[]): AssembledRow<M>[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const r of rows) {
    for (const tc of r.source?.toolCalls ?? []) callIds.add(tc.id);
    if (r.role === "tool" && r.source?.toolCallId) resultIds.add(r.source.toolCallId);
  }
  const kept = rows.filter((r) => !(r.role === "tool" && r.source?.toolCallId !== undefined && !callIds.has(r.source.toolCallId)));
  return kept;
}

/**
 * Upstream `_assemble_compressed`. `summary` is the handoff text with its
 * prefix. `messages` are all messages of the transcript, `window` the cut.
 */
export function assembleCompressed<M extends AssembleMessage>(messages: readonly M[], window: CompressionWindow, summary: string): AssembledRow<M>[] {
  const head = messages.slice(0, window.start);
  const tail = messages.slice(window.end);
  const p = summaryPlacement(head, tail, window.start);
  const rows: AssembledRow<M>[] = head.map((m) => ({ source: m, role: m.role, content: m.content ?? "", summary: false }));
  if (!p.mergeIntoTail) {
    // The end marker stops weak models from reading the quoted summary as new input.
    rows.push({ source: undefined, role: p.role, content: summary + "\n\n" + SUMMARY_END_MARKER, summary: true });
  }
  // The default carrier is tail[0]; the forced repair needs a user row with text, so it uses the first visible row.
  const mergeTarget = p.forceUserLeading && p.firstTailVisibleIdx !== null ? p.firstTailVisibleIdx : 0;
  tail.forEach((m, i) => {
    const old = m.content ?? "";
    if (p.mergeIntoTail && i === mergeTarget) {
      const content =
        p.forceUserLeading && p.role === "user"
          ? summary + "\n\n" + SUMMARY_END_MARKER + "\n\n" + old
          : MERGED_PRIOR_CONTEXT_HEADER + "\n" + old + "\n\n" + MERGED_SUMMARY_DELIMITER + "\n\n" + summary + "\n\n" + SUMMARY_END_MARKER;
      rows.push({ source: m, role: m.role, content, summary: true });
    } else {
      rows.push({ source: m, role: m.role, content: old, summary: false });
    }
  });
  return sanitizeToolPairs(rows);
}
