import { LEGACY_SUMMARY_PREFIX, SUMMARY_PREFIX } from "./upstream-text.ts";
import { messageBudgetTokens, type EstimatedMessage } from "./tokens.ts";
import { tailSoftCeiling, tailTokenBudget, type CompressionConfig, DEFAULT_COMPRESSION } from "./threshold.ts";

/**
 * Which messages are kept and which are summarised.
 *
 * Port of upstream `agent/context_compressor.py`: `_protect_head_size`,
 * `_align_boundary_forward`, `_align_boundary_backward`, `_find_tail_cut_by_tokens`
 * with `_walk_tail_budget`, the user and assistant anchors, and of
 * `agent/context_compressor_window.py`: `_compress_window`.
 *
 * The messages are in three regions: the head (kept), the middle (summarised),
 * and the tail (kept). A tool call and its results are never split: a cut
 * moves so that an assistant message with tool calls and the tool messages
 * that answer it are on the same side.
 *
 * Not ported: the pre-pass that replaces old tool results with stubs, the
 * multi-user anchor (`min_tail_user_messages`, default 1, which is off), the
 * rehydration scan of old handoff rows in the middle (the port keeps the one
 * summary row in the middle and folds it into the next summary), and the
 * media rules.
 */

export interface WindowMessage extends EstimatedMessage {
  role: string;
  content?: string | null;
  compressedSummary?: boolean | undefined;
}

export interface CompressionWindow {
  /** The head is `messages[0, start)`. */
  start: number;
  /** The tail is `messages[end, n)`. The middle is `messages[start, end)`. */
  end: number;
}

/** Upstream `_is_context_summary_message` (the part that matters here). */
export function isSummaryMessage(m: WindowMessage): boolean {
  if (m.compressedSummary) return true;
  const c = (m.content ?? "").trimStart();
  return c.startsWith(SUMMARY_PREFIX) || c.startsWith(LEGACY_SUMMARY_PREFIX);
}

/** Upstream `_is_real_user_turn`: a user message that is not a summary. */
function isRealUserTurn(m: WindowMessage): boolean {
  return m.role === "user" && !isSummaryMessage(m);
}

/** Upstream `_align_boundary_forward`: past any orphan tool results. */
export function alignBoundaryForward(messages: readonly WindowMessage[], idx: number): number {
  let i = idx;
  while (i < messages.length && messages[i]!.role === "tool") i++;
  return i;
}

/** Upstream `_align_boundary_backward`: do not split a tool group. */
export function alignBoundaryBackward(messages: readonly WindowMessage[], idx: number): number {
  if (idx <= 0 || idx >= messages.length) return idx;
  let check = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i]!.role !== "tool") {
      check = i;
      break;
    }
  }
  // Landed on the parent assistant: move before it so the group is summarised together.
  if (check >= 0 && messages[check]!.role === "assistant" && (messages[check]!.toolCalls?.length ?? 0) > 0) return check;
  return idx;
}

function findLastUserIdx(messages: readonly WindowMessage[], headEnd: number): number {
  for (let i = messages.length - 1; i >= headEnd; i--) if (isRealUserTurn(messages[i]!)) return i;
  return -1;
}

/** Upstream `_find_last_assistant_message_idx`: the last assistant reply with text, else the last assistant. */
function findLastAssistantIdx(messages: readonly WindowMessage[], headEnd: number): number {
  let lastAny = -1;
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant" || isSummaryMessage(m)) continue;
    if (lastAny < 0) lastAny = i;
    if ((m.content ?? "").trim() !== "") return i;
  }
  return lastAny;
}

/** Upstream `_find_turn_pair_end`. */
function findTurnPairEnd(messages: readonly WindowMessage[], userIdx: number): number {
  const idx = userIdx + 1;
  if (idx >= messages.length || messages[idx]!.role !== "assistant") return idx;
  return alignBoundaryForward(messages, idx + 1);
}

/** Upstream `_walk_tail_budget`: newest first, until the ceiling, once `minTail` rows are kept. */
function walkTailBudget(
  messages: readonly WindowMessage[],
  headEnd: number,
  ceiling: number,
  minTail: number,
  cutAtBreak: boolean,
): { cut: number; accumulated: number } {
  const n = messages.length;
  let accumulated = 0;
  let cut = n;
  for (let i = n - 1; i >= headEnd; i--) {
    const t = messageBudgetTokens(messages[i]!);
    if (accumulated + t > ceiling && n - i >= minTail) return { cut: cutAtBreak ? i : cut, accumulated };
    accumulated += t;
    cut = i;
  }
  return { cut, accumulated };
}

function hasToolCalls(m: WindowMessage): boolean {
  return (m.toolCalls?.length ?? 0) > 0;
}

/** Upstream `_ensure_last_user_message_in_tail`. */
function ensureLastUserInTail(messages: readonly WindowMessage[], cut: number, headEnd: number): number {
  const lastUser = findLastUserIdx(messages, headEnd);
  if (lastUser < 0 || lastUser >= cut) return cut;
  const adjusted = Math.max(lastUser, headEnd + 1);
  if (adjusted > lastUser) {
    // The clamp would leave the user without a reply: push forward past the whole pair.
    return Math.max(findTurnPairEnd(messages, lastUser), headEnd + 1);
  }
  return adjusted;
}

/** Upstream `_ensure_last_assistant_message_in_tail`. */
function ensureLastAssistantInTail(messages: readonly WindowMessage[], cut: number, headEnd: number): number {
  const lastAsst = findLastAssistantIdx(messages, headEnd);
  if (lastAsst < 0 || lastAsst >= cut) return cut;
  return Math.max(alignBoundaryBackward(messages, lastAsst), headEnd + 1);
}

/** Upstream `tail_cut_progress_floor`, for the common case: the window must hold a row that is not a handoff. */
function progressFloor(headEnd: number): number {
  return headEnd + 1;
}

/** Upstream `_find_tail_cut_by_tokens`: the start of the tail. */
export function findTailCut(messages: readonly WindowMessage[], headEnd: number, contextLength: number, cfg: CompressionConfig = DEFAULT_COMPRESSION): number {
  const budget = tailTokenBudget(contextLength, cfg);
  const n = messages.length;
  const availableTail = Math.max(0, n - headEnd - 1);
  const minTailFloor = Math.max(3, Math.min(cfg.protectLastN, 8));
  const compressibleTailCap = Math.max(3, availableTail - 2);
  const minTail = availableTail > 1 ? Math.min(minTailFloor, compressibleTailCap, availableTail) : 0;
  const soft = tailSoftCeiling(budget, contextLength);
  // The count floor is opportunistic: it is not used when the ceiling can hold that many empty rows.
  const walkFloor = soft >= minTail * messageBudgetTokens({ role: "user", content: "" }) ? 0 : minTail;

  let { cut, accumulated } = walkTailBudget(messages, headEnd, soft, walkFloor, false);
  // The whole transcript fits the soft ceiling: cut again with the raw budget so a middle exists.
  if (cut <= headEnd && accumulated > 0 && accumulated <= soft) cut = walkTailBudget(messages, headEnd, budget, minTail, true).cut;

  const fallbackCut = n - minTail;
  // The newest row never leaves the tail.
  cut = Math.min(cut, n - Math.max(walkFloor, 1));
  // Small conversations: force a cut after the head so that compression removes something.
  if (cut <= headEnd) cut = Math.max(fallbackCut, headEnd + 1);
  cut = alignBoundaryBackward(messages, cut);

  // Anchors: the last user message (the active task) and the last assistant reply stay in the tail.
  const lastUser = findLastUserIdx(messages, headEnd);
  const userAnchored = ensureLastUserInTail(messages, cut, headEnd);
  let splitOversizedTurn = false;
  if (
    userAnchored < cut &&
    lastUser >= 0 &&
    messageBudgetTokens(messages[lastUser]!) <= soft &&
    messages.slice(lastUser, cut).some(hasToolCalls) &&
    walkTailBudget(messages, userAnchored, soft, 0, false).cut > userAnchored
  ) {
    // One turn alone is over the ceiling: keep the tool-group-aligned cut, as upstream does.
    splitOversizedTurn = true;
  } else {
    cut = userAnchored;
  }
  if (!splitOversizedTurn) {
    const asstAnchored = ensureLastAssistantInTail(messages, cut, headEnd);
    let regionTokens = 0;
    for (let i = asstAnchored; i < cut; i++) regionTokens += messageBudgetTokens(messages[i]!);
    if (asstAnchored < cut && messages.slice(asstAnchored, cut).some(hasToolCalls) && regionTokens > soft) {
      // Keep the cut that the walk found.
    } else {
      cut = asstAnchored;
    }
  }
  // Progress: at least one row is summarised. Align forward only, so a tool group is not split.
  return Math.min(n, alignBoundaryForward(messages, Math.max(cut, progressFloor(headEnd))));
}

/** Upstream `_effective_protect_first_n`: the protected head decays to 0 once the session has a summary. */
export function protectHeadSize(messages: readonly WindowMessage[], cfg: CompressionConfig = DEFAULT_COMPRESSION): number {
  if (cfg.protectFirstN <= 0) return 0;
  return messages.some(isSummaryMessage) ? 0 : cfg.protectFirstN;
}

/**
 * Upstream `compress` (the plan, phases 1 and 2) with `_compress_window`: the
 * head, middle and tail of a transcript. Returns undefined when nothing can be
 * summarised (the transcript is too short, or fits the tail budget).
 */
export function planWindow(messages: readonly WindowMessage[], contextLength: number, cfg: CompressionConfig = DEFAULT_COMPRESSION): CompressionWindow | undefined {
  const n = messages.length;
  // Only the head and 3 messages of tail are needed at minimum. The token budget decides the real tail.
  const headSize = protectHeadSize(messages, cfg);
  if (n <= headSize + 3 + 1) return undefined;
  const start = alignBoundaryForward(messages, headSize);
  let end = findTailCut(messages, start, contextLength, cfg);
  // A summary merged into the first tail row must not swallow the active user message: keep an older
  // assistant or tool bridge before it. The bridge never goes below the progress floor.
  const latestUser = findLastUserIdx(messages, 0);
  if (end === latestUser) {
    let bridge = latestUser - 1;
    const role = bridge >= 0 ? messages[bridge]!.role : undefined;
    if (role === "tool") bridge = alignBoundaryBackward(messages, latestUser);
    else if (role !== "assistant") bridge = -1;
    if (bridge >= progressFloor(start)) end = bridge;
  }
  if (start >= end) return undefined;
  return { start, end };
}
