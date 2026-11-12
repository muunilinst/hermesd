import assert from "node:assert/strict";
import type { Stack, StackFactory } from "./types.ts";
import { terminalCall } from "./world.ts";

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
        await s.release("g1");
        assert.equal(await oneReply(s), "after the crash");
        const ids = new Set((await s.modelArrivals()).map((a) => a.callId));
        assert.equal(ids.size, 1, "every attempt of the call carries one call id");
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
      await withStack(make, { script: [{ reply: "woken" }] }, async (s) => {
        await s.crashAt({ actor: "s1", point: "fetch:before" });
        await s.send("hello");
        assert.equal(await oneReply(s), "woken");
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
        await waitFor(async () => (await s.rows("s1", "SELECT 1 FROM pending_op")).length > 0, "the operation row");
        await s.evict("s1");
        await s.release("c1");
        assert.equal(await oneReply(s), "finished");
        assert.equal(await s.executorRuns(), 1, "the command ran once");
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
        const found = async () => ((await s.call("profile", "session_search", { query: "zebra" })) as unknown[]).length > 0;
        // The outbox is delivered again by the session's own wake; the sweeper tick is the backstop.
        await waitFor(found, "the profile index", 15_000).catch(async () => {
          await s.cron("tick");
          await waitFor(found, "the profile index after a sweeper tick");
        });
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
