import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpId } from "@hermesd/executor-protocol";
import { deriveOpId } from "@hermesd/executor-protocol";
import { CellDownError, ProtocolError } from "./errors.ts";
import { ModelRig } from "./rig.ts";
import { TENANT, boot, expectStatus, prepareOp } from "./testing.ts";

async function setup() {
  const rig = new ModelRig();
  await boot(rig);
  return { rig, ex: rig.link("s1") };
}

describe("prepare", () => {
  it("is idempotent: same op_id and hash gives duplicate(status)", async () => {
    const { rig, ex } = await setup();
    const op = await prepareOp(rig, ex, "s1", "i1");
    const again = await ex.prepare({
      opId: op.opId,
      intentId: "i1",
      incarnation: op.incarnation,
      inputHash: op.inputHash,
      cmd: rig.commands.command(),
    });
    assert.deepEqual(again, { kind: "duplicate", status: { status: "prepared" } });
  });

  it("gives conflict for a different input hash", async () => {
    const { rig, ex } = await setup();
    const op = await prepareOp(rig, ex, "s1", "i1");
    const res = await ex.prepare({
      opId: op.opId,
      intentId: "i1",
      incarnation: op.incarnation,
      inputHash: "other",
      cmd: rig.commands.command(),
    });
    assert.deepEqual(res, { kind: "conflict" });
  });

  it("gives expired when the incarnation has passed, and records nothing", async () => {
    const { rig, ex } = await setup();
    const opId = await deriveOpId(TENANT, "s1", "late");
    await rig.cell.restoreDisks("save-1").catch(() => undefined); // VM is running: refused
    await rig.cell.stopVm();
    await rig.cell.restoreDisks("save-1");
    await rig.cell.startVm();
    const res = await ex.prepare({ opId, intentId: "late", incarnation: 1, inputHash: "h", cmd: rig.commands.command() });
    assert.deepEqual(res, { kind: "expired" });
    assert.equal(rig.cell.inspect().ops.has(opId), false);
  });

  it("refuses an incarnation from the future", async () => {
    const { rig, ex } = await setup();
    const opId = await deriveOpId(TENANT, "s1", "future");
    await assert.rejects(
      ex.prepare({ opId, intentId: "future", incarnation: 99, inputHash: "h", cmd: rig.commands.command() }),
      ProtocolError,
    );
  });
});

describe("start", () => {
  it("runs the command once and gives duplicate for later copies", async () => {
    const { rig, ex } = await setup();
    const op = await prepareOp(rig, ex, "s1", "i1", { stdout: "hi" });
    assert.deepEqual(await ex.start(op.opId, 1), { kind: "accepted" });
    await rig.settle();
    const dup = await ex.start(op.opId, 1);
    assert.equal(dup.kind, "duplicate");
    const done = expectStatus(await ex.status(op.opId), "done");
    assert.equal(done.result.stdout, "hi");
    assert.equal(rig.runCount(op.opId), 1);
  });

  it("reports a failing command as failed, with the result", async () => {
    const { rig, ex } = await setup();
    const op = await prepareOp(rig, ex, "s1", "i1", { exitCode: 3 });
    await ex.start(op.opId, 1);
    await rig.settle();
    const failed = expectStatus(await ex.status(op.opId), "failed");
    assert.equal(failed.result?.exitCode, 3);
  });

  it("refuses an epoch below the session minimum with stale_epoch", async () => {
    const { rig, ex } = await setup();
    const op = await prepareOp(rig, ex, "s1", "i1");
    await ex.fence("s1", 5);
    assert.deepEqual(await ex.start(op.opId, 4), { kind: "stale_epoch" });
    assert.equal(rig.runCount(op.opId), 0);
    assert.deepEqual(await ex.start(op.opId, 5), { kind: "accepted" });
  });

  it("throws for an operation that was never prepared, and runs nothing", async () => {
    const { ex } = await setup();
    const opId = (await deriveOpId(TENANT, "s1", "nope")) as OpId;
    await assert.rejects(ex.start(opId, 1), ProtocolError);
  });

  it("does not start while the VM is down", async () => {
    const { rig, ex } = await setup();
    const op = await prepareOp(rig, ex, "s1", "i1");
    await rig.cell.stopVm();
    await assert.rejects(ex.start(op.opId, 1));
    assert.equal(expectStatus(await ex.status(op.opId), "prepared").status, "prepared");
    assert.equal(rig.runCount(op.opId), 0);
  });
});

describe("fence", () => {
  it("raises the minimum epoch and returns the open operations", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a" });
    const b = await prepareOp(rig, ex, "s1", "b");
    await ex.start(a.opId, 7);
    const res = await ex.fence("s1", 8);
    assert.equal(res.minEpoch, 8);
    assert.deepEqual(
      res.open.map((o) => [o.opId, o.status.status]),
      [
        [a.opId, "running"],
        [b.opId, "prepared"],
      ],
    );
  });

  it("never lowers the minimum, and a lower fence adopts nothing", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    await ex.fence("s1", 8);
    const low = await ex.fence("s1", 6);
    assert.equal(low.minEpoch, 8);
    assert.equal(rig.cell.inspect().ops.get(a.opId)!.ownerEpoch, 8);
    assert.deepEqual(await ex.start(a.opId, 6), { kind: "stale_epoch" });
  });

  it("keeps a separate minimum epoch for each session", async () => {
    const { rig } = await setup();
    const s1 = rig.link("s1");
    const s2 = rig.link("s2");
    const a = await prepareOp(rig, s2, "s2", "a");
    await s1.fence("s1", 9);
    assert.deepEqual(await s2.start(a.opId, 1), { kind: "accepted" });
  });

  it("does not stop a running command (the window stays open)", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a" });
    await ex.start(a.opId, 1);
    await ex.fence("s1", 2);
    expectStatus(await ex.status(a.opId), "running");
    rig.commands.release("a");
    await rig.settle();
    expectStatus(await ex.status(a.opId), "done");
  });

  it("returns finished but unacknowledged operations, and not acknowledged ones", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    const b = await prepareOp(rig, ex, "s1", "b");
    await ex.start(a.opId, 1);
    await ex.start(b.opId, 1);
    await rig.settle();
    await ex.ack(b.opId, 1);
    const res = await ex.fence("s1", 2);
    assert.deepEqual(
      res.open.map((o) => [o.opId, o.status.status]),
      [[a.opId, "done"]],
    );
  });
});

describe("cancel and ack", () => {
  it("cancels a prepared operation and nothing runs later", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    assert.deepEqual(await ex.cancel(a.opId, 1), { kind: "stopped" });
    expectStatus(await ex.status(a.opId), "cancelled");
    assert.equal((await ex.start(a.opId, 1)).kind, "duplicate");
    assert.equal(rig.runCount(a.opId), 0);
  });

  it("answers not_found, already_done and stale_epoch", async () => {
    const { rig, ex } = await setup();
    const ghost = await deriveOpId(TENANT, "s1", "ghost");
    assert.deepEqual(await ex.cancel(ghost, 1), { kind: "not_found" });
    const a = await prepareOp(rig, ex, "s1", "a");
    await ex.start(a.opId, 1);
    await rig.settle();
    assert.deepEqual(await ex.cancel(a.opId, 1), { kind: "already_done" });
    await ex.fence("s1", 3);
    assert.deepEqual(await ex.cancel(a.opId, 2), { kind: "stale_epoch" });
    assert.deepEqual(await ex.ack(a.opId, 2), { kind: "stale_epoch" });
  });

  it("keeps a cancelled status when the late result arrives", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a" });
    await ex.start(a.opId, 1);
    assert.deepEqual(await ex.cancel(a.opId, 1), { kind: "stopped" });
    rig.commands.release("a");
    await rig.settle();
    expectStatus(await ex.status(a.opId), "cancelled");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("returns unknown when the end of the command is not known", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a" });
    await ex.start(a.opId, 1);
    await rig.cell.stopVm();
    await rig.cell.startVm();
    expectStatus(await ex.status(a.opId), "unknown");
    assert.deepEqual(await ex.cancel(a.opId, 1), { kind: "unknown" });
  });

  it("refuses to ack an operation that is not terminal", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    await assert.rejects(ex.ack(a.opId, 1), ProtocolError);
  });
});

describe("tombstones and retention", () => {
  it("keeps op_id, input hash, epoch and terminal status after ack, and drops the output", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { stdout: "secret" });
    await ex.start(a.opId, 4);
    await rig.settle();
    assert.deepEqual(await ex.ack(a.opId, 4), { kind: "acked" });
    assert.deepEqual(await ex.ack(a.opId, 4), { kind: "acked" });
    const rec = rig.cell.inspect().ops.get(a.opId)!;
    assert.equal(rec.inputHash, a.inputHash);
    assert.equal(rec.ownerEpoch, 4);
    assert.equal(rec.status.status, "done");
    const shown = expectStatus(await ex.status(a.opId), "done");
    assert.equal(shown.result.stdout, "");
    const dup = await ex.prepare({ opId: a.opId, intentId: "a", incarnation: a.incarnation, inputHash: "x", cmd: rig.commands.command() });
    assert.deepEqual(dup, { kind: "conflict" });
  });

  it("does not drop unacknowledged output by age when the operator sets no ceiling", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { stdout: "keep" });
    await ex.start(a.opId, 1);
    await rig.settle();
    rig.advanceClock(400 * 24 * 3600 * 1000);
    assert.deepEqual(rig.cell.collectExpiredOutput(), []);
    assert.equal(expectStatus(await ex.status(a.opId), "done").result.stdout, "keep");
  });

  it("applies the ceiling only after the 7 day floor", async () => {
    const rig = new ModelRig({ retention: { ceilingMs: 1000 } });
    await boot(rig);
    const ex = rig.link("s1");
    assert.equal(rig.cell.retention.ceilingMs, rig.cell.retention.floorMs);
    const a = await prepareOp(rig, ex, "s1", "a", { stdout: "x" });
    await ex.start(a.opId, 1);
    await rig.settle();
    expectStatus(await ex.status(a.opId), "done");
    rig.advanceClock(6 * 24 * 3600 * 1000);
    assert.deepEqual(rig.cell.collectExpiredOutput(), []);
    rig.advanceClock(2 * 24 * 3600 * 1000);
    assert.deepEqual(rig.cell.collectExpiredOutput(), [a.opId]);
    assert.equal(expectStatus(await ex.status(a.opId), "done").result.stdout, "");
  });

  it("collects tombstones of older incarnations and still refuses their operations", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    await ex.start(a.opId, 1);
    await rig.settle();
    await ex.ack(a.opId, 1);
    await rig.cell.stopVm();
    await rig.cell.restoreDisks("save-1");
    await rig.cell.startVm();
    assert.deepEqual(rig.cell.collectOldTombstones(), [a.opId]);
    assert.deepEqual(await ex.start(a.opId, 1), { kind: "expired" });
    const res = await ex.prepare({ opId: a.opId, intentId: "a", incarnation: a.incarnation, inputHash: a.inputHash, cmd: rig.commands.command() });
    assert.deepEqual(res, { kind: "expired" });
    assert.equal(rig.runCount(a.opId), 1);
  });
});

describe("the cell process", () => {
  it("refuses calls while it is down, and has no effect", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    rig.cell.crash();
    await assert.rejects(ex.start(a.opId, 1), CellDownError);
    await rig.cell.restart();
    assert.equal(rig.runCount(a.opId), 0);
    assert.deepEqual(await ex.start(a.opId, 1), { kind: "accepted" });
  });

  it("keeps the log over a restart", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { stdout: "kept" });
    await ex.start(a.opId, 1);
    await rig.settle();
    rig.cell.crash();
    await rig.cell.restart();
    assert.equal(expectStatus(await ex.status(a.opId), "done").result.stdout, "kept");
  });
});
