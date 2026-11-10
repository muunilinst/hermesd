import assert from "node:assert/strict";
import type { Executor, OpId, OpStatus } from "@hermesd/executor-protocol";
import { isTerminal } from "@hermesd/executor-protocol";
import type { FaultId } from "./catalogue.ts";
import type { CommandSpec, FaultWorld } from "./backend.ts";

/** One test, written against `FaultWorld` only. It throws when the fault is not survived. */
export interface FaultCaseDefinition {
  /** The case letter of the guide. Absent when the test has no cases. */
  caseId?: string;
  run(world: FaultWorld): Promise<void>;
}

export interface FaultDefinition {
  id: FaultId;
  cases: FaultCaseDefinition[];
}

// ------------------------------------------------------------------ helpers

interface Op {
  opId: OpId;
  intentId: string;
  incarnation: number;
  inputHash: string;
}

/** The first boot: start the VM through the executor. */
async function boot(world: FaultWorld): Promise<void> {
  await world.vm.start("executor");
}

/** Read the incarnation once, then prepare. This is what the session actor does. */
async function prepareOp(world: FaultWorld, ex: Executor, session: string, intentId: string, spec: CommandSpec = {}): Promise<Op> {
  const opId = await world.opId(session, intentId);
  const { incarnation } = await ex.describe(world.workspace);
  const inputHash = `hash-${intentId}`;
  const res = await ex.prepare({ session, opId, intentId, incarnation, inputHash, cmd: world.command(spec) });
  assert.deepEqual(res, { kind: "prepared" });
  return { opId, intentId, incarnation, inputHash };
}

/** Poll status until the operation is terminal. */
async function waitTerminal(world: FaultWorld, ex: Executor, opId: OpId): Promise<OpStatus> {
  for (let i = 0; i < 200; i++) {
    const s = await ex.status(opId);
    if (isTerminal(s.status)) return s;
    await world.pause(5);
  }
  assert.fail(`operation ${opId} did not end`);
}

async function incarnationOf(world: FaultWorld, session = "probe"): Promise<number> {
  return (await world.executor(session).describe(world.workspace)).incarnation;
}

/** Run an operation to the end. Returns the operation. Nothing is acknowledged. */
async function runToEnd(world: FaultWorld, ex: Executor, session: string, intentId: string, epoch: number): Promise<Op> {
  const op = await prepareOp(world, ex, session, intentId);
  assert.deepEqual(await ex.start(op.opId, epoch), { kind: "accepted" });
  assert.equal((await waitTerminal(world, ex, op.opId)).status, "done");
  return op;
}

function isMessageFailure(e: unknown): boolean {
  return e instanceof Error;
}

/** The call must fail with a transport error: the caller does not learn the answer. */
async function expectLost(call: Promise<unknown>): Promise<void> {
  await assert.rejects(call, (e: unknown) => isMessageFailure(e));
}

// --------------------------------------------------------------------- tests

const D2: FaultDefinition = {
  id: "D2",
  cases: [
    {
      async run(world) {
        await boot(world);
        const owner7 = world.executor("s1");
        const op = await prepareOp(world, owner7, "s1", "build", { hold: "d2", stdout: "built" });
        assert.deepEqual(await owner7.start(op.opId, 7), { kind: "accepted" });
        // The actor is shut down here. Its link and memory are gone.

        const owner8 = world.executor("s1");
        const fenced = await owner8.fence("s1", 8);
        assert.equal(fenced.minEpoch, 8);
        const open = fenced.open.find((o) => o.opId === op.opId);
        assert.ok(open, "the fence returns the operation");
        assert.equal(open.status.status, "running");

        await world.release("d2");
        const end = await waitTerminal(world, owner8, op.opId);
        assert.equal(end.status, "done");
        assert.equal(end.status === "done" && end.result.stdout, "built");
        assert.deepEqual(await owner8.ack(op.opId, 8), { kind: "acked" });
        assert.equal(await world.runCount(op.opId), 1);
      },
    },
  ],
};

const D4: FaultDefinition = {
  id: "D4",
  cases: [
    {
      async run(world) {
        await boot(world);
        const ex = world.executor("s1");
        const op = await prepareOp(world, ex, "s1", "build", { stdout: "kept" });
        ex.dropReplyNext("start");
        await expectLost(ex.start(op.opId, 1));

        const end = await waitTerminal(world, ex, op.opId);
        assert.equal(end.status, "done");
        assert.equal(end.status === "done" && end.result.stdout, "kept");
        // The retry with the same op_id does not run the command again.
        const retry = await ex.start(op.opId, 1);
        assert.equal(retry.kind, "duplicate");
        assert.equal(await world.runCount(op.opId), 1);
      },
    },
  ],
};

const D5: FaultDefinition = {
  id: "D5",
  cases: [
    {
      async run(world) {
        await boot(world);
        const ex = world.executor("s1");
        const op = await prepareOp(world, ex, "s1", "long", { hold: "d5" });
        assert.deepEqual(await ex.start(op.opId, 1), { kind: "accepted" });
        // The user sends /stop. The turn ends. The actor sends cancel.
        assert.deepEqual(await ex.cancel(op.opId, 1), { kind: "stopped" });
        // The late result arrives. It is accepted and discarded.
        await world.release("d5");
        assert.equal((await ex.status(op.opId)).status, "cancelled");
        assert.deepEqual(await ex.ack(op.opId, 1), { kind: "acked" });
        assert.equal(await world.runCount(op.opId), 1);
      },
    },
  ],
};

const D10: FaultDefinition = {
  id: "D10",
  cases: [
    {
      async run(world) {
        await boot(world);
        const first = world.executor("s1");
        const op = await prepareOp(world, first, "s1", "build");
        first.crashCallerAfterSendNext("start");
        await expectLost(first.start(op.opId, 1));
        // The caller is a new process. It recorded nothing, so it retries with the same op_id.

        const second = world.executor("s1");
        const retry = await second.start(op.opId, 1);
        assert.equal(retry.kind, "duplicate");
        assert.equal((await waitTerminal(world, second, op.opId)).status, "done");
        assert.equal(await world.runCount(op.opId), 1);
      },
    },
  ],
};

/** The delayed-copy checks that D11 (b) to (e) share. */
async function assertCopyRefused(world: FaultWorld, ex: Executor, ran: Op, notStarted: Op, delayed: { deliver(): Promise<unknown> }) {
  const before = await incarnationOf(world);
  assert.deepEqual(await delayed.deliver(), { kind: "expired" });
  assert.deepEqual(await ex.start(ran.opId, 1), { kind: "expired" });
  const again = await ex.prepare({
    session: "s1",
    opId: notStarted.opId,
    intentId: notStarted.intentId,
    incarnation: notStarted.incarnation,
    inputHash: notStarted.inputHash,
    cmd: world.command(),
  });
  assert.deepEqual(again, { kind: "expired" });
  assert.equal(await incarnationOf(world), before);
  assert.equal(await world.runCount(notStarted.opId), 0, "the delayed copy ran nothing");
  assert.equal(await world.runCount(ran.opId), 1, "the operation that ran before ran once");
}

/** Make a fresh operation on the new incarnation. It must run once. */
async function assertNextRunWorks(world: FaultWorld, ex: Executor, previous: number): Promise<void> {
  const now = await incarnationOf(world);
  assert.ok(now > previous, `the incarnation advanced (${previous} to ${now})`);
  const next = await runToEnd(world, ex, "s1", `next-${now}`, 1);
  assert.equal(next.incarnation, now);
  assert.equal(await world.runCount(next.opId), 1);
}

/**
 * The common start of (b), (c) and (e): save S1 is the older save. After it,
 * one operation is held in the network, and one operation ran.
 */
async function olderSaveScenario(world: FaultWorld) {
  await boot(world);
  const ex = world.executor("s1");
  await world.vm.stop("executor");
  const older = (await world.vm.info()).saveId;
  await world.vm.start("executor");
  const delayedStart = ex.delayNext("start");
  const notStarted = await prepareOp(world, ex, "s1", "delayed");
  await expectLost(ex.start(notStarted.opId, 1));
  const ran = await runToEnd(world, ex, "s1", "ran", 1);
  return { ex, older, notStarted, ran, delayed: delayedStart.deliverLast() };
}

const D11: FaultDefinition = {
  id: "D11",
  cases: [
    {
      caseId: "a",
      async run(world) {
        await boot(world);
        const ex = world.executor("s1");
        const op = await runToEnd(world, ex, "s1", "build", 1);
        assert.deepEqual(await ex.ack(op.opId, 1), { kind: "acked" });
        const copy = await ex.start(op.opId, 1); // a copy of start, same incarnation
        assert.equal(copy.kind, "duplicate");
        assert.equal(copy.kind === "duplicate" && copy.status.status, "done");
        assert.equal(await world.runCount(op.opId), 1);
      },
    },
    {
      caseId: "b",
      async run(world) {
        const { ex, older, notStarted, ran, delayed } = await olderSaveScenario(world);
        const before = await incarnationOf(world);
        await world.vm.stop("executor");
        await world.vm.restoreDisks(older, "executor");
        await world.vm.start("executor");
        await assertCopyRefused(world, ex, ran, notStarted, delayed);
        await assertNextRunWorks(world, ex, before);
      },
    },
    {
      caseId: "c",
      async run(world) {
        await boot(world);
        const ex = world.executor("s1");
        await world.vm.stop("executor");
        const older = await world.vm.info();
        await world.vm.start("executor");
        const delayedStart = ex.delayNext("start");
        const notStarted = await prepareOp(world, ex, "s1", "delayed");
        await expectLost(ex.start(notStarted.opId, 1));
        const ran = await prepareOp(world, ex, "s1", "ran-nothing");
        const before = await incarnationOf(world);
        await world.vm.stop("executor");
        // Nothing wrote to the journal since the older save, so its sequence
        // equals the highest the cell has seen. The sequence cannot tell.
        const latest = await world.vm.info();
        assert.equal(latest.journalSeq, older.journalSeq);
        assert.notEqual(latest.saveId, older.saveId);
        await world.vm.restoreDisks(older.saveId, "executor");
        assert.equal((await world.vm.info()).journalSeq, latest.journalSeq);
        await world.vm.start("executor");
        assert.deepEqual(await delayedStart.deliverLast().deliver(), { kind: "expired" });
        assert.deepEqual(await ex.start(ran.opId, 1), { kind: "expired" });
        assert.equal(await world.runCount(notStarted.opId), 0);
        assert.equal(await world.runCount(ran.opId), 0);
        await assertNextRunWorks(world, ex, before);
      },
    },
    {
      caseId: "d",
      async run(world) {
        await boot(world);
        const ex = world.executor("s1");
        const ran = await runToEnd(world, ex, "s1", "ran", 1);
        const notStarted = await prepareOp(world, ex, "s1", "delayed");
        const delayedStart = ex.delayNext("start");
        await expectLost(ex.start(notStarted.opId, 1));
        const before = await incarnationOf(world);
        await world.vm.stop("executor");
        const seq = (await world.vm.info()).journalSeq;
        const lineage = (await world.vm.info()).lineage;
        await world.vm.replaceImage("executor");
        const after = await world.vm.info();
        assert.equal(after.journalSeq, seq, "the data disk and its journal stay");
        assert.notEqual(after.lineage, lineage, "the lineage changes");
        await world.vm.start("executor");
        await assertCopyRefused(world, ex, ran, notStarted, delayedStart.deliverLast());
        await assertNextRunWorks(world, ex, before);
      },
    },
    {
      caseId: "e",
      async run(world) {
        const { ex, older, notStarted, ran, delayed } = await olderSaveScenario(world);
        const before = await incarnationOf(world);
        // An operator sends stop, restore and start to the VM. The executor sees none of them.
        await world.vm.stop("direct");
        await world.vm.restoreDisks(older, "direct");
        await world.vm.start("direct");
        await assertCopyRefused(world, ex, ran, notStarted, delayed);
        await assertNextRunWorks(world, ex, before);
      },
    },
  ],
};

const D13: FaultDefinition = {
  id: "D13",
  cases: [
    {
      async run(world) {
        await boot(world);
        const old = world.executor("s1");
        const running = await prepareOp(world, old, "s1", "old-command", { hold: "d13" });
        const lateStart = await prepareOp(world, old, "s1", "old-late-start");
        assert.deepEqual(await old.start(running.opId, 3), { kind: "accepted" });

        // The old owner keeps its command running while a new owner takes over.
        const owner = world.executor("s1");
        const fenced = await owner.fence("s1", 4);
        const returned = fenced.open.find((o) => o.opId === running.opId);
        assert.ok(returned, "the fence returns the operation");
        assert.equal(returned.status.status, "running");

        // The old owner is fenced out.
        assert.deepEqual(await old.start(lateStart.opId, 3), { kind: "stale_epoch" });
        assert.deepEqual(await old.cancel(running.opId, 3), { kind: "stale_epoch" });
        assert.deepEqual(await old.ack(running.opId, 3), { kind: "stale_epoch" });
        assert.equal(await world.runCount(lateStart.opId), 0);

        // The new owner settles the old operation before its own start.
        assert.deepEqual(await owner.cancel(running.opId, 4), { kind: "stopped" });
        await world.release("d13");
        assert.equal((await owner.status(running.opId)).status, "cancelled");
        assert.deepEqual(await owner.ack(running.opId, 4), { kind: "acked" });

        const own = await prepareOp(world, owner, "s1", "new-command");
        assert.deepEqual(await owner.start(own.opId, 4), { kind: "accepted" });
        assert.equal((await waitTerminal(world, owner, own.opId)).status, "done");
        assert.equal(await world.runCount(running.opId), 1);
        assert.equal(await world.runCount(own.opId), 1);
      },
    },
  ],
};

const D17: FaultDefinition = {
  id: "D17",
  cases: [
    {
      async run(world) {
        await boot(world);
        const owner7 = world.executor("s1");
        const op = await prepareOp(world, owner7, "s1", "build");
        // Owner 7 crashes before start.

        const owner8 = world.executor("s1");
        const fenced = await owner8.fence("s1", 8);
        const returned = fenced.open.find((o) => o.opId === op.opId);
        assert.ok(returned, "the fence returns the prepared operation");
        assert.equal(returned.status.status, "prepared");
        assert.deepEqual(await owner8.start(op.opId, 8), { kind: "accepted" });
        assert.equal((await waitTerminal(world, owner8, op.opId)).status, "done");

        // A late call from owner 7.
        assert.deepEqual(await owner7.start(op.opId, 7), { kind: "stale_epoch" });
        assert.equal(await world.runCount(op.opId), 1);
      },
    },
  ],
};

/** The fault tests that this harness defines. Other tests need a guest-level backend. */
export const FAULT_DEFINITIONS: readonly FaultDefinition[] = [D2, D4, D5, D10, D11, D13, D17];
