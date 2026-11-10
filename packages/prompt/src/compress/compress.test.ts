import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleCompressed } from "./assemble.ts";
import { planCompression, type PlannedMessage } from "./plan.ts";
import { boundSummaryInput, buildSummaryPrompt, elideMiddle, serializeRecords, staticFallbackSummary, stripSummaryPrefix, withSummaryPrefix } from "./summary.ts";
import {
  compressionConfig,
  computeThresholdTokens,
  hygieneNeeded,
  hygieneThresholdTokens,
  leanTailBudget,
  shouldCompress,
  tailTokenBudget,
  thresholdTokens,
} from "./threshold.ts";
import { estimateMessagesTokensRough, estimateTokensRough, messageBudgetTokens } from "./tokens.ts";
import { SUMMARY_END_MARKER, SUMMARY_PREFIX, HISTORICAL_TASK_HEADING } from "./upstream-text.ts";
import { alignBoundaryBackward, alignBoundaryForward, findTailCut, planWindow, protectHeadSize } from "./window.ts";

type M = PlannedMessage & { toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> };

const user = (content: string): M => ({ role: "user", content });
const asst = (content: string): M => ({ role: "assistant", content });
const call = (id: string, content = ""): M => ({ role: "assistant", content, toolCalls: [{ id, function: { name: "terminal", arguments: '{"command":"ls"}' } }] });
const result = (id: string, content = "ok"): M => ({ role: "tool", content, toolCallId: id });

describe("the token estimator (upstream estimate_tokens_rough)", () => {
  it("counts 4 ASCII characters for a token, rounded up", () => {
    assert.equal(estimateTokensRough(""), 0);
    assert.equal(estimateTokensRough("a"), 1);
    assert.equal(estimateTokensRough("abcd"), 1);
    assert.equal(estimateTokensRough("abcde"), 2);
    assert.equal(estimateTokensRough("x".repeat(400)), 100);
  });
  it("counts a CJK character as a token, and other text by its UTF-8 bytes", () => {
    assert.equal(estimateTokensRough("你好"), 2);
    assert.equal(estimateTokensRough("é"), 1); // 2 bytes
    assert.equal(estimateTokensRough("привет"), 3); // 12 bytes
    assert.equal(estimateTokensRough("你好 abc"), 2 + 1); // 2 dense + 4 bytes
  });
  it("a message costs its content plus 10, and the tool-call envelope, in the tail budget", () => {
    assert.equal(messageBudgetTokens({ role: "user", content: "x".repeat(40) }), 10 + 10);
    const withCall = messageBudgetTokens(call("c1", ""));
    assert.ok(withCall > 10);
  });
  it("a request is the sum of its messages", () => {
    const ms = [user("x".repeat(100)), asst("y".repeat(100))];
    assert.equal(estimateMessagesTokensRough(ms), estimateMessagesTokensRough([ms[0]!]) + estimateMessagesTokensRough([ms[1]!]));
  });
});

describe("the thresholds", () => {
  it("50% for a window of 512K tokens and more", () => {
    assert.equal(thresholdTokens(1_000_000), 500_000);
    assert.equal(thresholdTokens(512_000), 256_000);
    assert.equal(shouldCompress(499_999, 1_000_000), false);
    assert.equal(shouldCompress(500_000, 1_000_000), true);
  });
  it("a window under 512K is raised to 75%, with the 64K floor and the 85% limit where the floor binds", () => {
    assert.equal(thresholdTokens(128_000), 96_000);
    assert.equal(thresholdTokens(200_000), 150_000);
    assert.equal(thresholdTokens(64_000), 54_400);
    assert.equal(computeThresholdTokens(100_000, 0.5, 40_000), 51_000, "the reserved output is taken off first, then the floor is capped at 85%");
  });
  it("the floors can be set for a test", () => {
    const cfg = compressionConfig({ minimumContextLength: 0, smallContextWindowLimit: 0 });
    assert.equal(thresholdTokens(1000, cfg), 500);
    assert.equal(shouldCompress(500, 1000, cfg), true);
    assert.equal(thresholdTokens(1000, compressionConfig({ minimumContextLength: 0, smallContextWindowLimit: 0, thresholdTokensCap: 300 })), 300);
  });
  it("the gateway safety net is 85% of the window, or 5000 messages", () => {
    assert.equal(hygieneThresholdTokens(1_000_000), 850_000);
    assert.equal(hygieneNeeded(849_999, 10, 1_000_000), false);
    assert.equal(hygieneNeeded(850_000, 10, 1_000_000), true);
    assert.equal(hygieneNeeded(1, 5000, 1_000_000), true);
    assert.equal(hygieneNeeded(1, 4999, 1_000_000), false);
  });
  it("the lean tail is 2.5% of the window between 10K and 25K tokens", () => {
    assert.equal(leanTailBudget(1_000_000, 500_000), 25_000);
    assert.equal(leanTailBudget(200_000, 150_000), 10_000);
    assert.equal(tailTokenBudget(1_000_000), 25_000);
    assert.equal(leanTailBudget(100, 50), 25, "never more than half of a tiny trigger");
  });
});

describe("which messages are kept", () => {
  /** user, then n rounds of: assistant with a call, the result, an assistant text. */
  function transcript(rounds: number, size = 400): M[] {
    const out: M[] = [user("start " + "s".repeat(size))];
    for (let i = 0; i < rounds; i++) {
      out.push(call(`c${i}`, "think " + "t".repeat(size)), result(`c${i}`, "r".repeat(size)), asst("done " + "d".repeat(size)), user("more " + "u".repeat(size)));
    }
    return out;
  }
  const small = compressionConfig({ minimumContextLength: 0, smallContextWindowLimit: 0 });

  it("the head is protected once, then decays to 0 when a summary exists", () => {
    assert.equal(protectHeadSize([user("a"), asst("b")]), 3);
    assert.equal(protectHeadSize([{ role: "user", content: SUMMARY_PREFIX + "\nbody" }, user("b")]), 0);
    assert.equal(protectHeadSize([{ role: "user", content: "x", compressedSummary: true }]), 0);
  });

  it("a short transcript is not compressed", () => {
    assert.equal(planWindow(transcript(1), 1000, small), undefined);
  });

  it("keeps the head, summarises the middle, keeps a tail with the last user message", () => {
    const ms = transcript(12);
    const w = planWindow(ms, 8_000, small)!;
    assert.ok(w, "a window");
    assert.equal(w.start, 3, "protect_first_n");
    assert.ok(w.end > w.start && w.end < ms.length);
    assert.ok(w.end <= ms.length - 3, "a tail of 3 messages at least");
    const lastUser = ms.map((m) => m.role).lastIndexOf("user");
    assert.ok(w.end <= lastUser, "the last user message is in the tail");
  });

  it("a tool call and its results are never split, for many shapes", () => {
    for (let rounds = 3; rounds < 16; rounds++) {
      for (const size of [10, 150, 700]) {
        for (const ctx of [3_000, 8_000, 30_000]) {
          const ms = transcript(rounds, size);
          // A parallel call in the middle.
          ms.splice(5, 0, { role: "assistant", content: "", toolCalls: [{ id: "p1", function: { name: "a", arguments: "{}" } }, { id: "p2", function: { name: "b", arguments: "{}" } }] }, result("p1"), result("p2"));
          const w = planWindow(ms, ctx, small);
          if (!w) continue;
          for (const cut of [w.start, w.end]) {
            if (cut >= ms.length) continue;
            assert.notEqual(ms[cut]!.role, "tool", `a cut at ${cut} is on a tool result (rounds ${rounds}, size ${size}, ctx ${ctx})`);
          }
          // Each call is on the same side of the cut as its results.
          const side = (i: number): number => (i < w.start ? 0 : i < w.end ? 1 : 2);
          ms.forEach((m, i) => {
            for (const tc of m.toolCalls ?? []) {
              const r = ms.findIndex((x) => x.role === "tool" && x.toolCallId === tc.id);
              assert.equal(side(i), side(r), `call ${tc.id} and its result are split`);
            }
          });
        }
      }
    }
  });

  it("alignment: forward past orphan results, backward before the parent assistant", () => {
    const ms = [user("u"), call("a"), result("a"), result("a"), asst("x")];
    assert.equal(alignBoundaryForward(ms, 2), 4);
    assert.equal(alignBoundaryBackward(ms, 3), 1);
    assert.equal(alignBoundaryBackward(ms, 4), 1, "after the results, still the group start");
    assert.equal(alignBoundaryBackward(ms, 1), 1);
    assert.equal(alignBoundaryBackward(ms, 0), 0);
  });

  it("the tail follows the token budget: a large recent message keeps the tail short", () => {
    const ms = transcript(12, 3000);
    const cut = findTailCut(ms, 3, 60_000, small);
    assert.ok(cut > 3 && cut < ms.length);
    const tailTokens = ms.slice(cut).reduce((n, m) => n + messageBudgetTokens(m), 0);
    assert.ok(tailTokens <= tailTokenBudget(60_000, small) * 1.5 + 3000, `tail ${tailTokens}`);
  });
});

describe("the summary prompt and the handoff text", () => {
  const turns: M[] = [user("Please fix the build."), call("c1", "Looking."), result("c1", "error: boom"), asst("Fixed it.")];
  const input = { turns, contextLength: 100_000, today: "2026-01-15" };

  it("the first form has the preamble, the records and the template", () => {
    const p = buildSummaryPrompt(input);
    assert.ok(p.startsWith("You are a summarization agent creating a context checkpoint."));
    assert.ok(p.includes("Create a structured checkpoint summary for the conversation after earlier turns are compacted."));
    assert.ok(p.includes("TURNS TO SUMMARIZE:\n[USER]: Please fix the build.\n\n[ASSISTANT]: Looking.\n[Tool calls:\n  terminal({\"command\":\"ls\"})\n]\n\n[TOOL RESULT c1]: error: boom\n\n[ASSISTANT]: Fixed it."));
    assert.ok(p.includes(`${HISTORICAL_TASK_HEADING}\n[THE SINGLE MOST IMPORTANT FIELD.`));
    assert.ok(p.includes("TEMPORAL ANCHORING: The current date is 2026-01-15."));
    assert.ok(p.includes("Target ~2000 tokens."));
    assert.ok(p.endsWith("Write only the summary body. Do not include any preamble or prefix."));
  });
  it("the iterative form carries the previous summary", () => {
    const p = buildSummaryPrompt({ ...input, previousSummary: "OLD BODY" });
    assert.ok(p.includes("You are updating a context compaction summary."));
    assert.ok(p.includes("PREVIOUS SUMMARY:\nOLD BODY\n\nNEW TURNS TO INCORPORATE:\n[USER]"));
    assert.equal(p.includes("TURNS TO SUMMARIZE:"), false);
  });
  it("a focus topic goes last; a transcript with no user turn uses the other wording", () => {
    assert.ok(buildSummaryPrompt({ ...input, focusTopic: "the build" }).includes('\n\nFOCUS TOPIC: "the build"\n'));
    const none = buildSummaryPrompt({ ...input, turns: [asst("cron output")] });
    assert.ok(none.includes("This session contains no user-authored turns."));
  });
  it("records are cut in the middle when long, with upstream's marker", () => {
    const long = "a".repeat(9000);
    const [rec] = serializeRecords([user(long)]);
    assert.ok(rec!.includes("⟪HERMES-CONTEXT-COMPRESSION: 3,500 of 9,000 chars omitted here by Hermes's context compressor.⟫"));
    assert.equal(elideMiddle("abc", 2, 2), "abc");
    const bounded = boundSummaryInput("z".repeat(200_000));
    assert.ok(bounded.length <= 160_000 + 10 && bounded.includes("summary input truncated: omitted"));
  });
  it("the prefix is added once and stripped with the end marker", () => {
    const h = withSummaryPrefix("BODY");
    assert.equal(h, `${SUMMARY_PREFIX}\nBODY`);
    assert.equal(withSummaryPrefix(h), h);
    assert.equal(stripSummaryPrefix(h + "\n\n" + SUMMARY_END_MARKER), "BODY");
  });
  it("the static fallback has the headings and the last turns", () => {
    const s = staticFallbackSummary(turns, { reason: "HTTP 500" });
    assert.ok(s.startsWith(SUMMARY_PREFIX));
    assert.ok(s.includes("User asked: 'Please fix the build.'"));
    assert.ok(s.includes("## Last Dropped Turns\n- USER: Please fix the build."));
    assert.ok(s.includes("Summary failure reason: HTTP 500."));
    assert.ok(s.includes("best-effort deterministic fallback for 4 compacted message(s)."));
  });
});

describe("the new transcript", () => {
  const small = compressionConfig({ minimumContextLength: 0, smallContextWindowLimit: 0 });

  it("head, then the summary row, then the tail; roles alternate", () => {
    const ms: M[] = [user("u0"), asst("a0"), user("u1"), asst("a1"), user("u2"), asst("a2"), user("u3"), asst("a3"), user("u4")];
    const plan = planCompression(ms, { contextLength: 400, today: "", config: small })!;
    assert.ok(plan);
    const rows = assembleCompressed(ms, plan.window, withSummaryPrefix("S"));
    const roles = rows.map((r) => r.role);
    const summaryAt = rows.findIndex((r) => r.summary);
    assert.ok(summaryAt >= plan.window.start - 0 && summaryAt <= plan.window.start);
    for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1], `roles alternate: ${roles.join(",")}`);
    assert.equal(roles.at(-1), "user");
    assert.equal(rows.filter((r) => r.summary).length, 1);
    const sr = rows[summaryAt]!;
    assert.ok(sr.content.endsWith(SUMMARY_END_MARKER));
  });

  it("when no role fits, the summary is merged into the first tail row", () => {
    // head ends with an assistant -> the summary is a user row; the tail starts with an assistant -> no collision.
    const ms: M[] = [user("u0"), asst("a0"), user("u1"), asst("a1"), user("u2"), asst("a2")];
    const rows = assembleCompressed(ms, { start: 2, end: 3 }, withSummaryPrefix("S"));
    assert.deepEqual(rows.map((r) => r.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
    assert.equal(rows[2]!.summary, true);
    assert.equal(rows[2]!.source, undefined);
    // head ends with an assistant, the tail starts with a user: the summary (user) would collide, and
    // the flip to assistant collides with the head -> merge into the tail row.
    const collide = assembleCompressed(ms, { start: 2, end: 4 }, withSummaryPrefix("S"));
    assert.equal(collide.length, 4);
    assert.equal(collide[2]!.summary, true);
    assert.ok(collide[2]!.content.includes("[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]"));
    const merged = assembleCompressed([user("u0"), user("u1"), asst("a1")], { start: 1, end: 2 }, withSummaryPrefix("S"));
    // head ends with user -> assistant summary; tail starts with assistant -> flip to user collides with the head -> merge.
    assert.equal(merged.length, 2);
    assert.equal(merged[1]!.summary, true);
    assert.ok(merged[1]!.content.startsWith("[PRIOR CONTEXT — for reference only; not a new message]\na1\n\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]"));
  });

  it("an earlier summary row in the middle is folded in, not repeated as a turn", () => {
    const ms: M[] = [
      { role: "user", content: withSummaryPrefix("OLD") + "\n\n" + SUMMARY_END_MARKER, compressedSummary: true },
      asst("a0"),
      user("u1"),
      asst("a1"),
      user("u2"),
      asst("a2"),
      user("u3"),
      asst("a3"),
      user("u4"),
    ];
    const plan = planCompression(ms, { contextLength: 400, today: "", config: small })!;
    assert.equal(plan.previousSummary, "OLD");
    assert.equal(plan.window.start, 0, "no protected head after a summary");
    assert.equal(plan.turns.some((t) => t.compressedSummary), false);
    assert.ok(plan.prompt.includes("PREVIOUS SUMMARY:\nOLD"));
  });
});
