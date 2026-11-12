import assert from "node:assert/strict";
import type { Stack, StackFactory } from "./types.ts";
import { benchScript, terminalCall } from "./world.ts";

/**
 * Scenarios that run unchanged on every host. Each one builds a fresh stack, drives
 * it through the Stack interface only, and checks the outcome the guide asks for.
 * The fault ids are those of guide 7.3 (packages/faults/src/catalogue.ts). On a real
 * platform the crash is the platform's own (an abort of the object, a crash of the
 * actor), not a simulated one.
 */
export interface Scenario {
  name: string;
  fault?: string;
  run(make: StackFactory): Promise<void>;
}

async function withStack(make: StackFactory, opts: Parameters<StackFactory>[0], fn: (s: Stack) => Promise<void>): Promise<void> {
  const s = await make(opts);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

async function oneReply(s: Stack, timeoutMs?: number): Promise<string> {
  const r = await s.waitReplies(1, timeoutMs);
  assert.equal(r.length, 1, `one reply, got ${JSON.stringify(r)}`);
  return r[0]!.text;
}

async function settledTurns(s: Stack): Promise<void> {
  const open = await s.rows("s1", "SELECT id FROM turns WHERE status = 'open'");
  assert.deepEqual(open, [], "no turn is left open");
  const pending = await s.rows("s1", "SELECT call_id FROM pending_call WHERE status = 'pending'");
  assert.deepEqual(pending, [], "no model call is left pending");
}

export const SCENARIOS: Scenario[] = [
  {
    name: "a plain turn completes",
    async run(make) {
      await withStack(make, { script: [{ reply: "hi there" }] }, async (s) => {
        await s.send("hello");
        assert.equal(await oneReply(s), "hi there");
        await settledTurns(s);
      });
    },
  },
  {
    name: "a terminal call runs once and the turn completes",
    async run(make) {
      await withStack(make, { script: [{ toolCalls: [terminalCall({ stdout: "hello\n" })] }, { reply: "it said hello" }] }, async (s) => {
        await s.send("run echo hello");
        assert.equal(await oneReply(s), "it said hello");
        assert.equal(await s.executorRuns(), 1);
        await settledTurns(s);
      });
    },
  },
  {
    name: "terminal-call turns back to back, each sent as soon as the last reply arrives",
    async run(make) {
      const turns = 8;
      await withStack(make, { script: benchScript(turns, 1) }, async (s) => {
        for (let i = 0; i < turns; i++) {
          await s.send(`turn ${i}`);
          const replies = await s.waitReplies(i + 1, 30_000);
          assert.equal(replies[i]!.text, `done ${i}`);
        }
        assert.equal(await s.executorRuns(), turns, "each command ran once");
        await settledTurns(s);
      });
    },
  },
  {
    name: "a model call longer than the idle sleep timeout finishes without a re-send",
    async run(make) {
      await withStack(make, { script: [{ reply: "slow answer" }], modelDelayMs: 2_500 }, async (s) => {
        await s.send("hello");
        assert.equal(await oneReply(s), "slow answer");
        assert.equal((await s.modelArrivals()).length, 1, "the actor stayed awake: one model request");
        await settledTurns(s);
      });
    },
  },
  {
    name: "the same message delivered twice makes one turn",
    fault: "D3",
    async run(make) {
      await withStack(make, { script: [{ reply: "once" }, { reply: "twice" }] }, async (s) => {
        await s.send("hello", "req-dup");
        await s.send("hello", "req-dup");
        assert.equal(await oneReply(s), "once");
        const adm = await s.rows("s1", "SELECT seq FROM session_admissions");
        assert.equal(adm.length, 1, "one admission row");
        assert.equal((await s.modelArrivals()).length, 1, "one model request");
      });
    },
  },
  {
    name: "an eviction while the model call is open: the wake re-sends it under the same call id",
    fault: "D1",
    async run(make) {
      await withStack(make, { script: [{ reply: "after the crash", hold: "g1" }] }, async (s) => {
        await s.send("hello");
        await waitFor(async () => (await s.modelArrivals()).length >= 1, "the model call");
        await s.evict("s1");
        // A request wakes the actor on the real hosts (on Node the wake timer does, below): the new activation
        // sends the model request again while the first is still held.
        await s.epochOf("s1");
        await s.release("g1");
        assert.equal(await oneReply(s), "after the crash");
        // The wake must have sent the request again, under the id of the first one.
        await waitFor(async () => {
          await s.advance(500);
          return (await s.modelArrivals()).length >= 2;
        }, "a second model request");
        const arrivals = await s.modelArrivals();
        const ids = arrivals.map((a) => a.callId);
        assert.ok(ids[0], "the first request carries a call id");
        assert.ok(ids.every((id) => id === ids[0]), `every attempt carries the same call id: ${JSON.stringify(ids)}`);
        await settledTurns(s);
      });
    },
  },
  {
    name: "a crash after the model request left, before the answer was seen",
    fault: "D1",
    async run(make) {
      await withStack(make, { script: [{ reply: "seen once" }] }, async (s) => {
        await s.crashAt({ actor: "s1", point: "fetch:after" });
        await s.send("hello");
        assert.equal(await oneReply(s), "seen once");
        assert.equal((await s.replies()).length, 1, "no duplicate reply");
        await settledTurns(s);
      });
    },
  },
  {
    name: "a crash after the pending row commits and before the request leaves: the wake alone brings the turn back",
    fault: "D9 (b)",
    async run(make) {
      // No automatic sweeper tick or sweep, and a horizon far beyond the test: only the session's own
      // wake timer, armed before the crash, can bring the turn back.
      await withStack(make, { script: [{ reply: "woken" }], autoSweep: false, horizonMs: 3_600_000 }, async (s) => {
        await s.crashAt({ actor: "s1", point: "fetch:before" });
        await s.send("hello");
        assert.equal(await oneReply(s), "woken");
        assert.equal(await s.crashesFired(), 1, "the injected crash fired");
        assert.equal((await s.modelArrivals()).length, 1, "the request left once, after the wake");
        await settledTurns(s);
      });
    },
  },
  {
    name: "an eviction while a terminal command runs: the command runs once",
    fault: "D2 (actor side)",
    async run(make) {
      await withStack(make, { script: [{ toolCalls: [terminalCall({ stdout: "ok\n", hold: "c1" })] }, { reply: "finished" }] }, async (s) => {
        await s.send("run it");
        // The operation row is written before the executor gets `start`. Wait for the executor to have
        // recorded the one execution (the command is held), so the eviction falls after the command began.
        await waitFor(async () => (await s.executorRuns()) === 1, "the executor to run the held command");
        await s.evict("s1");
        await s.release("c1");
        assert.equal(await oneReply(s), "finished");
        assert.equal(await s.executorRuns(), 1, "the command ran once: recovery did not start it again");
        await settledTurns(s);
      });
    },
  },
  {
    name: "a crash before the profile index update: the outbox catches up",
    fault: "D12",
    async run(make) {
      await withStack(make, { script: [{ reply: "the zebra answer" }] }, async (s) => {
        await s.crashAt({ actor: "s1", point: "sidecar:before", detail: "actor:profile.index" });
        await s.send("tell me about zebras");
        assert.equal(await oneReply(s), "the zebra answer");
        const userRows = await s.rows("s1", "SELECT id, content FROM messages WHERE role = 'user' AND content LIKE '%zebras%'");
        assert.equal(userRows.length, 1, "one user message about zebras");
        const seq = Number(userRows[0]!["id"]);
        const found = async () => {
          const hits = (await s.call("profile", "session_search", { query: "zebras" })) as Array<{ session: string; seq: number; role: string; text: string }>;
          return hits.some((h) => h.role === "user" && h.seq === seq && h.text.includes("zebras"));
        };
        // The outbox is delivered again by the session's own wake; the sweeper tick is the backstop.
        await waitFor(found, "the user message in the profile index", 15_000).catch(async () => {
          await s.cron("tick");
          await waitFor(found, "the user message in the profile index after a sweeper tick");
        });
        assert.equal(await s.crashesFired(), 1, "the injected crash fired");
      });
    },
  },
  {
    name: "rows accepts one read-only statement and refuses anything else, without changing the actor",
    async run(make) {
      await withStack(make, { script: [{ reply: "hi" }] }, async (s) => {
        await s.send("hello");
        assert.equal(await oneReply(s), "hi");
        const count = async () => Number((await s.rows("s1", "SELECT COUNT(*) AS n FROM turns"))[0]!["n"]);
        const before = await count();
        assert.ok(before > 0);
        assert.equal(Number((await s.rows("s1", "SELECT 1 AS n;"))[0]!["n"]), 1, "one trailing semicolon is fine");
        assert.equal(Number((await s.rows("s1", "WITH t AS (SELECT 2 AS n) SELECT n FROM t"))[0]!["n"]), 2);
        for (const bad of [
          "SELECT 1; DELETE FROM turns",
          "SELECT 1;; DELETE FROM turns",
          "DELETE FROM turns",
          "WITH t AS (SELECT 1) DELETE FROM turns",
          "UPDATE turns SET status = 'x'",
          "SELECT 1; SELECT 2",
        ]) {
          await assert.rejects(s.rows("s1", bad), /./, `refused: ${bad}`);
        }
        assert.equal(await count(), before, "no statement changed the rows");
      });
    },
  },
];

export async function waitFor(fn: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
