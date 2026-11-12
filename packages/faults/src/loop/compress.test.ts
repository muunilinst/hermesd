import assert from "node:assert/strict";
import { it } from "node:test";
import { SUMMARY_END_MARKER, SUMMARY_PREFIX, estimateMessagesTokensRough } from "@hermesd/prompt";
import type { CompressionConfig } from "@hermesd/prompt";
import { admissionState } from "../actor/admission.ts";
import { eachLoopWorld } from "./test-util.ts";
import { type LoopWorld } from "./world.ts";

// Compression in the loop: the 50% threshold before the call, the gateway
// hygiene check at 85%, and a crash during the summary call. The summary call
// is a pending_call with its own wake obligation, like any model call.

/** Small windows need the floors of the compressor lowered. The object is shared with the loop, so a test can change it. */
function lowFloors(): Partial<CompressionConfig> {
  return { minimumContextLength: 0, smallContextWindowLimit: 0 };
}

const WINDOW = 4000;
const CHARS = 900;

/** The body of a test that needs state shared between the options and the body. */
const lazy = (f: () => () => Promise<void>): (() => Promise<void>) => f();

/** A user text of about `chars` characters. Each call gives different text. */
function text(n: number, chars: number): string {
  return `turn ${n} `.concat("lorem ipsum dolor ".repeat(Math.ceil(chars / 18))).slice(0, chars);
}

const replies = (n: number) => Array.from({ length: n }, (_v, i) => ({ reply: `answer ${i}` }));

async function turn(w: LoopWorld, n: number, chars: number): Promise<void> {
  const before = w.replies.length;
  await w.send(text(n, chars));
  await w.until(() => w.replies.length === before + 1, `the reply of turn ${n}`);
}

/** The table exists after the first activation. */
function nLinks(w: LoopWorld): number {
  try {
    return w.rows("compaction_link").length;
  } catch {
    return 0;
  }
}

const compressionCalls = (w: LoopWorld) => w.rows("pending_call").filter((r) => String(r.call_id).includes(":k"));
const data = (r: Record<string, unknown>) => JSON.parse(String(r.data)) as Record<string, unknown>;

/** The rows that the model sees after the compaction: the summary row is in the child session. */
function assertCompactedOnce(w: LoopWorld): { child: string } {
  assert.equal(nLinks(w), 1, "exactly one compaction");
  return assertLineage(w);
}

/** Every link is done, and the newest child holds one active summary row. */
function assertLineage(w: LoopWorld): { child: string } {
  const links = w.rows("compaction_link");
  assert.ok(links.length >= 1);
  assert.ok(links.every((l) => l.status === "done"));
  const link = links.at(-1)!;
  const child = String(link.child_id);
  assert.equal(w.rows("sessions", `id = '${child}'`)[0]!.parent_session_id, String(link.parent_id));
  assert.equal(w.rows("sessions", "id = 's1'")[0]!.end_reason, "compression");
  assert.equal(w.rows("messages", "session_id = 's1' AND active = 1").length, 0, "no parent row is active");
  assert.ok(w.rows("messages", "session_id = 's1' AND compacted = 1").length > 0, "the parent rows are marked compacted");
  const summaries = w.rows("messages", `session_id = '${child}' AND _compressed_summary = 1 AND active = 1`);
  assert.ok(summaries.length >= 1, "a summary row in the child");
  assert.ok(summaries.some((r) => String(r.content).includes(SUMMARY_PREFIX) && String(r.content).includes(SUMMARY_END_MARKER)));
  return { child };
}

eachLoopWorld("compression at 50%", (use) => {
  it(
    "a turn over the threshold sends a summary call first, then the real call in the child session",
    lazy(() => {
      const compression = lowFloors();
      return use({ script: replies(30), loop: { contextWindow: WINDOW, tools: [], compression } }, async (w) => {
        let n = 0;
        while (nLinks(w) === 0 && n < 20) await turn(w, ++n, CHARS);
        assert.ok(n < 20, "the threshold was reached");
        assert.ok(n >= 5, "not at the first turns");
        const k = compressionCalls(w);
        assert.equal(k.length, 1);
        assert.equal(k[0]!.status, "done");
        const d = data(k[0]!);
        assert.equal(d.purpose, "compression");
        assert.equal(d.reason, "threshold");
        assert.ok(Number(d.tokens_before) >= WINDOW * 0.5, "the measure was at or over 50%");
        assert.ok(Number(d.tokens_before) < WINDOW * 0.5 + 400, "the turn before was under 50%");
        const { child } = assertCompactedOnce(w);
        assert.deepEqual(await callAgain(w, "lineage_problems"), []);

        // The summary request has the summary prompt only. It carries no tools.
        const reqs = w.model.recorder.requests;
        const sumReq = reqs.find((r) => String(r.callId).includes(":k"))!;
        const sumBody = sumReq.body as { messages: Array<{ role: string; content: string }>; tools: unknown[] };
        assert.equal(sumBody.messages.length, 1);
        assert.equal(sumBody.tools.length, 0);
        assert.match(sumBody.messages[0]!.content, /summar/i);

        // The real call follows with the child's rows: head, summary, tail. It is shorter than the history.
        const real = reqs.at(-1)!.body as { messages: Array<{ role: string; content: string }> };
        assert.ok(real.messages.some((m) => String(m.content).includes(SUMMARY_PREFIX)), "the model sees the summary");
        assert.ok(real.messages.some((m) => String(m.content).includes(text(n, CHARS).slice(0, 40))), "the new input is kept");
        const kept = w.rows("messages", `session_id = '${child}' AND active = 1`);
        assert.ok(kept.length < n * 2, "the child is shorter than the parent");
        // The messages of the kept head and tail have the uids of the parent: nothing is lost or made twice.
        const uids = kept.map((m) => m.message_uid);
        assert.equal(new Set(uids).size, uids.length);
        assert.equal(w.replies.length, n);
        const link = w.rows("compaction_link")[0]!;
        const ld = data(link);
        assert.equal(ld.kind, "window");
        assert.equal(ld.fallback, false);
        assert.ok(Number(ld.tokens_after) < Number(ld.tokens_before));
        w.assertConsistent();
        // Later turns go on in the child.
        await turn(w, n + 1, 200);
        assert.equal(w.rows("messages", `session_id = '${child}' AND role = 'assistant'`).length >= 1, true);
        w.assertConsistent();
      });
    }),
  );

  it(
    "a tool call and its result are never split by the cut",
    lazy(() => {
      const compression = lowFloors();
      const script = [] as Array<Record<string, unknown>>;
      for (let i = 0; i < 20; i++) script.push({ toolCalls: [{ name: "todo_list", arguments: { todos: [{ id: `t${i}`, content: `item ${i}`, status: "pending" }] } }] }, { reply: `done ${i}` });
      return use({ script: script as never, loop: { contextWindow: WINDOW, tools: ["todo_list"], compression } }, async (w) => {
        let n = 0;
        while (nLinks(w) === 0 && n < 20) await turn(w, ++n, 700);
        assert.ok(n < 20);
        assertLineage(w);
        const active = w.rows("messages", "active = 1");
        for (const m of active) {
          if (m.role === "tool") {
            assert.ok(
              active.some((a) => typeof a.tool_calls === "string" && (JSON.parse(a.tool_calls) as Array<{ id: string }>).some((c) => c.id === m.tool_call_id)),
              "a result has its call",
            );
          }
        }
        w.assertConsistent();
      });
    }),
  );

  it(
    "a failing summary model gives the static fallback and the turn goes on",
    lazy(() => {
      const compression = lowFloors();
      const script = [...replies(8), { status: 400 }, ...replies(10)];
      return use({ script, loop: { contextWindow: WINDOW, tools: [], compression } }, async (w) => {
        // Eight turns fill the history; the ninth sends the summary call, which fails hard.
        for (let n = 1; n <= 9; n++) await turn(w, n, CHARS);
        assert.ok(nLinks(w) >= 1);
        const ld = data(w.rows("compaction_link")[0]!);
        assert.equal(ld.fallback, true);
        assert.equal(w.replies.length, 9, "the user got an answer");
        assert.match(String(w.rows("messages", "_compressed_summary = 1")[0]!.content), /unavailable/);
        assertLineage(w);
        w.assertConsistent();
      });
    }),
  );

  it(
    "the faithful trigger: a 1M window is compressed at 500K tokens, not before",
    lazy(() => {
      const compression: Partial<CompressionConfig> = {};
      return use({ script: replies(40), loop: { contextWindow: 1_000_000, tools: [], compression } }, async (w) => {
        let n = 0;
        let sentChars = 0;
        while (nLinks(w) === 0 && n < 30) {
          n += 1;
          sentChars += 100_000;
          await turn(w, n, 100_000);
        }
        assert.ok(n < 30);
        const d = data(compressionCalls(w)[0]!);
        assert.equal(d.reason, "threshold");
        assert.equal(d.threshold, 500_000);
        assert.ok(Number(d.tokens_before) >= 500_000);
        // The turn before was under: one more turn adds about 25K tokens.
        assert.ok(Number(d.tokens_before) < 500_000 + 30_000, `tokens_before ${String(d.tokens_before)}`);
        assert.ok(sentChars / 4 >= 480_000);
        assertCompactedOnce(w);
      });
    }),
  );
});

eachLoopWorld("compression at 85% (gateway hygiene)", (use) => {
  it(
    "history over 85% of the window is compressed before the agent runs, though the threshold is not reached",
    lazy(() => {
      // The trigger is moved to 99% so that only the hygiene check can fire.
      const compression: Partial<CompressionConfig> = { ...lowFloors(), thresholdPercent: 0.99 };
      return use({ script: replies(40), loop: { contextWindow: WINDOW, tools: [], compression } }, async (w) => {
        const history = (): number => {
          try {
            return estimateMessagesTokensRough(w.rows("messages", "active = 1").map((r) => ({ role: String(r.role), content: String(r.content ?? "") })));
          } catch {
            return 0; // the tables exist after the first activation
          }
        };
        let n = 0;
        while (history() < WINDOW * 0.85 && n < 30) await turn(w, ++n, CHARS);
        assert.ok(n < 30);
        assert.equal(nLinks(w), 0, "nothing was compressed on the way up");
        assert.ok(history() < WINDOW * 0.99);
        await turn(w, ++n, CHARS);
        assert.equal(nLinks(w), 1);
        const d = data(compressionCalls(w)[0]!);
        assert.equal(d.reason, "hygiene");
        assertCompactedOnce(w);
        assert.deepEqual(await callAgain(w, "lineage_problems"), []);
        w.assertConsistent();
      });
    }),
  );
});

// ------------------------------------------------------------------ a crash during the summary call

/** Warm up to the turn that sends the summary call. Returns the turn number of the trigger. */
const WARM = 8;

function crashWorld(extra: Array<Record<string, unknown>> = []): { compression: Partial<CompressionConfig>; script: never } {
  const compression: Partial<CompressionConfig> = { ...lowFloors(), thresholdPercent: 0.99 };
  const script = [...replies(WARM), ...extra, ...replies(12)];
  return { compression, script: script as never };
}

async function warm(w: LoopWorld, compression: Partial<CompressionConfig>): Promise<void> {
  for (let n = 1; n <= WARM; n++) await turn(w, n, CHARS);
  assert.equal(nLinks(w), 0);
  compression.thresholdPercent = 0.5;
}

/** Wake the actor until the trigger turn has ended. */
async function drain(w: LoopWorld): Promise<void> {
  // A busy machine finishes the queued work slowly, so wait for the rounds and for a wall-clock
  // budget, as `until` does. The turn must still end; the assertions after this check how.
  const deadline = Date.now() + 30_000;
  for (let i = 0; i < 12 || Date.now() < deadline; i++) {
    await w.b.settle();
    const adm = w.rows("session_admissions");
    if (adm.length === WARM + 1 && /^(terminal|unknown)/.test(String(admissionState(adm[WARM]!)))) break;
    await w.wakeAll();
  }
  // A reply that is still in the outbox leaves now.
  await callAgain(w, "flush_outbox");
  await w.b.settle();
}

/** A call may meet a crash that is still armed. The crash fires once, so the second try runs on a new activation. */
async function callAgain(w: LoopWorld, method: string): Promise<unknown> {
  for (let i = 0; i < 3; i++) {
    try {
      return await w.b.call("s1", method, {});
    } catch {
      await w.b.settle();
    }
  }
  return w.b.call("s1", method, {});
}

function assertOneCompaction(w: LoopWorld): void {
  const k = compressionCalls(w);
  assert.equal(k.length, 1, "one summary call");
  assert.equal(k[0]!.status, "done");
  assert.equal(nLinks(w), 1, "no double compaction");
  assert.equal(w.rows("sessions", "parent_session_id = 's1'").length, 1, "one child session");
  assertCompactedOnce(w);
  const adm = w.rows("session_admissions");
  const state = admissionState(adm[WARM]!);
  // The turn completes, or it ends as unknown when the owner was lost between the compaction step
  // and the next step (the runtime then asks the user; it never repeats the compaction).
  assert.ok(state === "terminal:completed" || state === "unknown", `the turn state is ${String(state)}`);
  if (state === "terminal:completed") {
    assert.equal(w.replies.length, WARM + 1, "one reply for each turn");
    assert.equal(new Set(w.replies.map((r) => r.key)).size, WARM + 1);
  }
  w.assertConsistent();
}

eachLoopWorld("D1 crash during the summary call", (use) => {
  it(
    "before the summary request leaves: it is sent once, after the wake",
    lazy(() => {
      const { compression, script } = crashWorld();
      return use({ script, loop: { contextWindow: WINDOW, tools: [], compression } }, async (w) => {
        await warm(w, compression);
        const sent = w.model.recorder.requests.length;
        w.b.crashAt({ actor: "s1", point: "fetch:before" });
        await w.send(text(WARM + 1, CHARS));
        await w.until(() => compressionCalls(w).length === 1, "the summary call row");
        await w.b.settle();
        assert.equal(compressionCalls(w)[0]!.status, "pending");
        assert.equal(nLinks(w), 0);
        assert.equal(w.model.recorder.requests.length, sent, "the request never left");
        assert.equal(w.rows("wake_obligations", "state = 'open'").length >= 1, true, "a wake obligation is open");
        await drain(w);
        assertOneCompaction(w);
      });
    }),
  );

  it(
    "during the call: the same call_id is sent again and the summary is used once",
    lazy(() => {
      const { compression, script } = crashWorld([{ hold: "g1", reply: "SUMMARY BODY" }]);
      return use({ script, loop: { contextWindow: WINDOW, tools: [], compression } }, async (w) => {
        await warm(w, compression);
        const sent = w.model.recorder.requests.length;
        await w.send(text(WARM + 1, CHARS));
        await w.until(() => w.model.recorder.requests.length === sent + 1, "the summary request at the model");
        w.b.crash("s1");
        w.model.release("g1");
        await w.b.settle();
        assert.equal(compressionCalls(w)[0]!.status, "pending");
        assert.equal(nLinks(w), 0, "the lost answer was not used");
        await drain(w);
        const ids = w.model.recorder.requests.slice(sent).map((r) => r.callId);
        assert.equal(ids[0], ids[1], "a retry reuses the call_id");
        assertOneCompaction(w);
        assert.match(String(w.rows("messages", "_compressed_summary = 1 AND active = 1")[0]!.content), /SUMMARY BODY/);
      });
    }),
  );

  it(
    "after the response, before the actor saw it: the call is driven again",
    lazy(() => {
      const { compression, script } = crashWorld([{ reply: "SUMMARY BODY" }]);
      return use({ script, loop: { contextWindow: WINDOW, tools: [], compression } }, async (w) => {
        await warm(w, compression);
        w.b.crashAt({ actor: "s1", point: "fetch:after" });
        await w.send(text(WARM + 1, CHARS));
        await w.until(() => compressionCalls(w).length === 1, "the summary call row");
        await w.b.settle();
        assert.equal(nLinks(w), 0);
        await drain(w);
        assertOneCompaction(w);
        assert.match(String(w.rows("messages", "_compressed_summary = 1 AND active = 1")[0]!.content), /SUMMARY BODY/);
      });
    }),
  );

  // After the summary request has left, crash at the n-th write. n covers the commit that
  // writes the child, the second commit that turns the parent rows inactive, and the
  // writes of the real call after them.
  for (const point of ["tx:before", "tx:before-commit", "commit:after"] as const) {
    for (let nth = 1; nth <= 6; nth++) {
      it(
        `a crash at ${point} #${nth} after the summary request: one compaction, a clean reply`,
        lazy(() => {
          const { compression, script } = crashWorld([{ reply: "SUMMARY BODY" }]);
          return use({ script, loop: { contextWindow: WINDOW, tools: [], compression } }, async (w) => {
            await warm(w, compression);
            w.b.onPoint({ actor: "s1", point: "fetch:after" }, () => {
              w.b.crashAt({ actor: "s1", point, nth });
            });
            await w.send(text(WARM + 1, CHARS)).catch(() => {});
            await drain(w);
            assertOneCompaction(w);
            assert.deepEqual(await callAgain(w, "lineage_problems"), []);
          });
        }),
      );
    }
  }
});

eachLoopWorld("the summary call and an interrupt", (use) => {
  it(
    "a stop while the summary call is out ends the turn without a compaction",
    lazy(() => {
      const { compression, script } = crashWorld([{ hold: "g1", reply: "SUMMARY BODY" }]);
      return use({ script, loop: { contextWindow: WINDOW, tools: [], compression } }, async (w) => {
        await warm(w, compression);
        const sent = w.model.recorder.requests.length;
        await w.send(text(WARM + 1, CHARS));
        await w.until(() => w.model.recorder.requests.length === sent + 1, "the summary request at the model");
        await w.stop();
        await w.until(() => w.replies.length === WARM + 1, "the stop reply");
        assert.equal(nLinks(w), 0);
        assert.equal(compressionCalls(w)[0]!.status, "cancelled");
        w.assertConsistent();
      });
    }),
  );
});
