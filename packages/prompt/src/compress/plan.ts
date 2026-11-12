import { stripSummaryPrefix, buildSummaryPrompt, type SummaryMessage } from "./summary.ts";
import { DEFAULT_COMPRESSION, type CompressionConfig } from "./threshold.ts";
import { isSummaryMessage, planWindow, type CompressionWindow, type WindowMessage } from "./window.ts";

/**
 * One compression, planned: the cut, the messages to summarise, and the
 * prompt for the summary model. This joins `planWindow` and `buildSummaryPrompt`
 * the way upstream `compress()` does in its phases 1 to 3. It makes no model
 * call. The caller sends the prompt, then calls `assembleCompressed`.
 */

export type PlannedMessage = SummaryMessage & WindowMessage;

export interface CompressionPlan<M extends PlannedMessage> {
  window: CompressionWindow;
  /** The messages that the summary replaces, without the earlier summary row. */
  turns: M[];
  /** The body of the earlier summary that the new one updates. */
  previousSummary: string | undefined;
  /** The text to send to the summary model. */
  prompt: string;
}

export function planCompression<M extends PlannedMessage>(
  messages: readonly M[],
  opts: { contextLength: number; today: string; config?: CompressionConfig; focusTopic?: string },
): CompressionPlan<M> | undefined {
  const cfg = opts.config ?? DEFAULT_COMPRESSION;
  const window = planWindow(messages, opts.contextLength, cfg);
  if (!window) return undefined;
  const middle = messages.slice(window.start, window.end);
  // An earlier summary row in the middle is folded into the new summary (the iterative form).
  const summaryRows = middle.filter(isSummaryMessage);
  const previousSummary = summaryRows.length > 0 ? stripSummaryPrefix(summaryRows[summaryRows.length - 1]!.content ?? "") : undefined;
  const turns = middle.filter((m) => !isSummaryMessage(m));
  // The window holds only handoff rows: nothing to summarise (upstream: empty_post_handoff_window).
  if (turns.length === 0) return undefined;
  const prompt = buildSummaryPrompt({
    turns,
    previousSummary,
    focusTopic: opts.focusTopic,
    contextLength: opts.contextLength,
    today: opts.today,
  });
  return { window, turns, previousSummary, prompt };
}
