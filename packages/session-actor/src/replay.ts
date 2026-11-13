import type { NewMessage } from "./messages.ts";

/**
 * What an interrupted turn leaves in the rows, and how those rows are replayed to
 * the model. Upstream: `agent/replay_cleanup.py`, `agent/turn_failure_copy.py`,
 * `agent/agent_runtime_helpers_placeholders.py` (hermes-agent a9ff979).
 *
 * The rows keep what happened: the cut-off command's result carries the executor's
 * interrupt marker, and the turn is closed by an assistant row. Every request then
 * rewrites an interrupted result of a tool that may have side effects into a notice
 * that its effect is UNKNOWN, so the model inspects state before it retries.
 */

/** The result the executor gives a killed terminal command (`tools/environments/`, exit 130). */
export const INTERRUPTED_COMMAND_RESULT = JSON.stringify({ output: "[Command interrupted]", exit_code: 130, error: null });

/** The result of a call that the interrupt stopped before it ran (`tool_executor.py:emit_cancelled`). */
export const CANCELLED_CALL_RESULT = JSON.stringify({ error: "Tool execution cancelled. Turn interrupted", status: "cancelled" });

/** The assistant row that closes a turn that ended with no answer and no tool run. */
export const FAILED_TURN_NOTICE = "Your request was not processed. Send it again if you still want me to carry it out.";
/** The same, when a tool may already have run in the turn. */
export const PARTIAL_FAILED_TURN_NOTICE = "This turn did not complete. Some actions may already have run; verify their effects before resending.";
/** `messages.display_kind` of a failed-turn boundary row. */
export const FAILED_TURN_DISPLAY_KIND = "failed_turn";

/** What the model reads in place of an empty assistant row that closes an interrupted tool run. */
export const INTERRUPTED_PLACEHOLDER = "[interrupt: no assistant output for this turn]";

const INTERRUPTED_NOTICES = [
  "[Orphan recovery: interrupted side-effecting tool may have executed; its effect is UNKNOWN. Inspect state before retrying.]",
  "[Orphan recovery: interrupted read-only tool did not complete.]",
] as const;

/** Tools whose interrupted run cannot have changed anything (`tool_result_classification.py:NO_EFFECT_TOOL_NAMES`). */
const NO_EFFECT_TOOL_NAMES = new Set([
  "read_file", "search_files", "session_search", "skill_view", "skills_list",
  "web_extract", "web_search", "vision_analyze", "browser_snapshot",
  "browser_get_images", "browser_console", "read_terminal",
]);

export const toolMayHaveSideEffect = (name: string): boolean => !NO_EFFECT_TOOL_NAMES.has(name);

/** The hidden assistant row that closes an interrupted tool run (`hidden_interrupt_placeholder_row`). */
export function interruptPlaceholderRow(messageUid: string): NewMessage {
  return { role: "assistant", content: "", apiContent: INTERRUPTED_PLACEHOLDER, displayKind: "hidden", messageUid };
}

/** The boundary row of a failed turn (`failed_turn_notice`): never "not processed" when a tool may have run. */
export function failedTurnRow(turnMessages: readonly NewMessage[], messageUid: string): NewMessage {
  const toolRan = turnMessages.some((m) => m.role === "tool" || (m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0));
  return { role: "assistant", content: toolRan ? PARTIAL_FAILED_TURN_NOTICE : FAILED_TURN_NOTICE, displayKind: FAILED_TURN_DISPLAY_KIND, messageUid };
}

const INTERRUPT_MARKER_LINE = /^\[(?:command|execution) interrupted\b[^\n]*\]\s*$/i;

/**
 * `is_interrupted_tool_result`: the marker is the last line of the output, in a JSON
 * envelope with a non-zero exit code or as bare text. A marker quoted inside a
 * successful output is data.
 */
export function isInterruptedToolResult(content: unknown): boolean {
  if (typeof content !== "string") return false;
  let output: unknown = content;
  if (content.trimStart().startsWith("{")) {
    let env: unknown;
    try {
      env = JSON.parse(content);
    } catch {
      return false;
    }
    if (typeof env !== "object" || env === null || Array.isArray(env)) return false;
    const e = env as Record<string, unknown>;
    if (e.exit_code === 0 || e.exit_code === null || e.exit_code === undefined) return false;
    output = e.output;
    if (typeof output !== "string") return false;
  }
  const lines = (output as string).trimEnd().split("\n");
  return INTERRUPT_MARKER_LINE.test(lines[lines.length - 1]!);
}

/**
 * `strip_interrupted_tool_tails`, on the lines that go to the model. A block whose
 * calls are all read-only is dropped. A block with a call that may have side effects
 * is kept, with each interrupted result rewritten as an orphan-recovery notice. An
 * interrupted tool row outside a block is dropped. The input is not changed.
 */
export function stripInterruptedToolTails(history: readonly NewMessage[]): NewMessage[] {
  const out: NewMessage[] = [];
  let i = 0;
  while (i < history.length) {
    const m = history[i]!;
    if (m.role === "assistant" && m.toolCalls !== undefined) {
      let j = i + 1;
      while (j < history.length && history[j]!.role === "tool") j++;
      const results = history.slice(i + 1, j);
      if (results.some((r) => isInterruptedToolResult(r.content))) {
        const calls = m.toolCalls;
        if (calls.some((c) => toolMayHaveSideEffect(c.function.name))) {
          const names = new Map(calls.map((c) => [c.id, c.function.name]));
          out.push(m);
          for (const r of results) {
            if (!isInterruptedToolResult(r.content)) {
              out.push(r);
              continue;
            }
            const name = names.get(r.toolCallId ?? "") ?? "";
            out.push({ ...r, content: INTERRUPTED_NOTICES[toolMayHaveSideEffect(name) ? 0 : 1] });
          }
        }
        i = j;
        continue;
      }
    }
    if (!(m.role === "tool" && isInterruptedToolResult(m.content))) out.push(m);
    i++;
  }
  return out;
}
