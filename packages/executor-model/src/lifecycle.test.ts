import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CellCrashedError } from "./errors.ts";
import { ModelRig } from "./rig.ts";
import { boot, expectStatus, prepareOp } from "./testing.ts";

async function setup() {
  const rig = new ModelRig();
  await boot(rig);
  return { rig, ex: rig.link() };
}

async function incarnation(rig: ModelRig): Promise<number> {
  return (await rig.link().describe(rig.workspace)).incarnation;
}

/** Run one operation to the end and acknowledge it. */
async function runOne(rig: ModelRig, intent: string) {
  const ex = rig.link();
  const op = await prepareOp(rig, ex, "s1", intent);
  await ex.start(op.opId, 1);
  await rig.settle();
  return op;
}

describe("incarnation: the VM lifecycle rule", () => {
  it("starts incarnation 1 at the first boot", async () => {
    const { rig } = await setup();
    assert.equal(await incarnation(rig), 1);
  });

  it("keeps the incarnation over a stop and start through the cell", async () => {
    const { rig } = await setup();
    await rig.cell.stopVm();
    await rig.cell.startVm();
    assert.equal(await incarnation(rig), 1);
    assert.equal(rig.cell.inspect().advances.length, 1);
  });

  it("advances after a stop that the cell did not see (operator stop)", async () => {
    const { rig } = await setup();
    rig.vm.stop();
    rig.vm.start();
    assert.equal(await incarnation(rig), 2);
  });

  it("advances after a restore sent directly, even to the save of the last stop", async () => {
    const { rig } = await setup();
    await rig.cell.stopVm();
    const last = rig.vm.peek().save.id;
    rig.vm.restoreDisks(last);
    rig.vm.start();
    assert.equal(await incarnation(rig), 2);
  });

  it("advances at once for a restore sent through the cell, and only once", async () => {
    const { rig } = await setup();
    await rig.cell.stopVm();
    await rig.cell.restoreDisks("save-1");
    assert.equal((await rig.cell.describe(rig.workspace)).incarnation, 2);
    await rig.cell.startVm();
    assert.equal(await incarnation(rig), 2);
  });

  it("advances for replace_image, which keeps the data disk and its journal", async () => {
    const { rig } = await setup();
    const op = await runOne(rig, "a");
    await rig.cell.stopVm();
    const seq = rig.vm.peek().journalSeq;
    await rig.cell.replaceImage();
    assert.equal(rig.vm.peek().journalSeq, seq);
    assert.equal(rig.vm.disk.journal.has(op.opId), true);
    await rig.cell.startVm();
    assert.equal(await incarnation(rig), 2);
    assert.equal(rig.cell.inspect().advances.at(-1)?.reason, "replace_image");
  });

  it("advances for a direct replace_image", async () => {
    const { rig } = await setup();
    await rig.cell.stopVm();
    rig.vm.replaceImage();
    rig.vm.start();
    assert.equal(await incarnation(rig), 2);
    assert.match(rig.cell.inspect().advances.at(-1)!.reason, /save is not|lineage|between/);
  });

  it("advances for a discard through the cell and for a direct discard", async () => {
    const a = await setup();
    await a.rig.cell.discard();
    await a.rig.cell.startVm();
    assert.equal(await incarnation(a.rig), 2);
    const b = await setup();
    b.rig.vm.discard();
    b.rig.vm.start();
    assert.equal(await incarnation(b.rig), 2);
  });

  it("advances for recovery_required, direct or through the cell", async () => {
    const a = await setup();
    a.rig.vm.markRecoveryRequired();
    assert.equal(await incarnation(a.rig), 2);
    a.rig.vm.recover();
    a.rig.vm.start();
    assert.ok((await incarnation(a.rig)) >= 3);
    const b = await setup();
    b.rig.vm.markRecoveryRequired();
    await b.rig.cell.recover();
    await b.rig.cell.startVm();
    assert.ok((await incarnation(b.rig)) >= 2);
  });

  it("advances when the host was lost with unsaved disks", async () => {
    const { rig } = await setup();
    rig.vm.loseHost();
    rig.vm.start();
    assert.equal(await incarnation(rig), 2);
  });

  it("advances when the journal sequence is lower than the highest seen, as an extra check", async () => {
    const { rig } = await setup();
    await runOne(rig, "a");
    await rig.cell.stopVm();
    rig.vm.forceJournalSeq(0);
    await rig.cell.startVm();
    assert.equal(await incarnation(rig), 2);
    assert.equal(rig.cell.inspect().advances.at(-1)?.reason, "the journal sequence is lower than the highest seen");
  });

  it("does not trust an equal journal sequence: the lifecycle rule decides", async () => {
    const { rig } = await setup();
    await rig.cell.stopVm(); // save-2, journal seq 0
    await rig.cell.startVm();
    await rig.cell.stopVm(); // save-3, journal seq 0
    rig.vm.restoreDisks("save-2"); // direct, same journal sequence as save-3
    rig.vm.start();
    assert.equal(rig.vm.peek().journalSeq, rig.cell.inspect().highestJournalSeq);
    assert.equal(await incarnation(rig), 2);
  });

  it("advances when the save is a candidate", async () => {
    const { rig } = await setup();
    rig.vm.markRecoveryRequired();
    rig.vm.recover();
    assert.equal(rig.vm.peek().save.candidate, true);
  });

  it("never lowers the incarnation, also after a restore of the oldest save", async () => {
    const { rig } = await setup();
    const seen: number[] = [await incarnation(rig)];
    for (const id of ["save-1", "save-1", "save-1"]) {
      await rig.cell.stopVm();
      await rig.cell.restoreDisks(id);
      await rig.cell.startVm();
      seen.push(await incarnation(rig));
    }
    assert.deepEqual(seen, [1, 2, 3, 4]);
  });

  it("refuses prepare and start for an operation of a lower incarnation, and nothing runs", async () => {
    const { rig, ex } = await setup();
    const early = await prepareOp(rig, ex, "s1", "early");
    const ran = await runOne(rig, "ran");
    await rig.cell.stopVm();
    await rig.cell.restoreDisks("save-1");
    await rig.cell.startVm();
    assert.deepEqual(await ex.start(early.opId, 1), { kind: "expired" });
    assert.deepEqual(await ex.start(ran.opId, 1), { kind: "expired" });
    assert.equal(rig.runCount(early.opId), 0);
    assert.equal(rig.runCount(ran.opId), 1);
    expectStatus(await ex.status(early.opId), "expired");
    expectStatus(await ex.status(ran.opId), "done");
  });

  it("makes a started operation without a result unknown when the incarnation advances", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a" });
    await ex.start(a.opId, 1);
    await rig.cell.stopVm();
    await rig.cell.restoreDisks("save-1");
    await rig.cell.startVm();
    expectStatus(await ex.status(a.opId), "unknown");
    rig.commands.release("a");
    await rig.settle();
    expectStatus(await ex.status(a.opId), "unknown");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("checks a lifecycle crash: a restore sent through the cell is found even if the cell died before the record", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    await rig.cell.stopVm();
    rig.cell.crashAt("lifecycle:vm-done");
    await assert.rejects(rig.cell.restoreDisks("save-1"), CellCrashedError);
    await rig.cell.restart();
    rig.vm.start();
    assert.equal(await incarnation(rig), 2);
    assert.deepEqual(await ex.start(a.opId, 1), { kind: "expired" });
  });
});

describe("what failed / what the executor does (section 3.4)", () => {
  it("caller restarted: the command runs on; the new owner fences, adopts and reads through status", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a", stdout: "out" });
    await ex.start(a.opId, 7);
    const newCaller = rig.link();
    const fenced = await newCaller.fence("s1", 8);
    assert.equal(fenced.open[0]?.status.status, "running");
    rig.commands.release("a");
    await rig.settle();
    assert.equal(expectStatus(await newCaller.status(a.opId), "done").result.stdout, "out");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("owner node died: a new owner restores the log and resolves dispatching through the helper", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a" });
    rig.cell.crashAt("start:guest-launched");
    await assert.rejects(ex.start(a.opId, 1), CellCrashedError);
    assert.equal(rig.cell.inspect().ops.get(a.opId)!.status.status, "dispatching");
    await rig.failover();
    expectStatus(await ex.status(a.opId), "running");
    rig.commands.release("a");
    await rig.settle();
    expectStatus(await ex.status(a.opId), "done");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("owner node died before the guest saw the launch: the new owner launches once", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    rig.cell.crashAt("start:dispatching-written");
    await assert.rejects(ex.start(a.opId, 1), CellCrashedError);
    assert.equal(rig.runCount(a.opId), 0);
    await rig.failover();
    await rig.settle();
    expectStatus(await ex.status(a.opId), "done");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("owner node died after the cell recorded running: nothing launches again", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a" });
    rig.cell.crashAt("start:running-recorded");
    await assert.rejects(ex.start(a.opId, 1), CellCrashedError);
    await rig.failover();
    await rig.failover();
    rig.commands.release("a");
    await rig.settle();
    expectStatus(await ex.status(a.opId), "done");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("guest helper restarted, VM up: reconciliation by journal and cgroup adopts the command", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a" });
    await ex.start(a.opId, 1);
    rig.guest.restartHelper();
    expectStatus(await ex.status(a.opId), "running");
    rig.commands.release("a");
    await rig.settle();
    expectStatus(await ex.status(a.opId), "done");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("VM stopped and started: same incarnation; written exit statuses are read back; a running command is unknown", async () => {
    const { rig, ex } = await setup();
    const fast = await prepareOp(rig, ex, "s1", "fast", { stdout: "x" });
    const slow = await prepareOp(rig, ex, "s1", "slow", { hold: "slow" });
    await ex.start(fast.opId, 1);
    await rig.settle();
    await ex.start(slow.opId, 1);
    await rig.cell.stopVm();
    await rig.cell.startVm();
    assert.equal(await incarnation(rig), 1);
    assert.equal(expectStatus(await ex.status(fast.opId), "done").result.stdout, "x");
    expectStatus(await ex.status(slow.opId), "unknown");
    assert.equal(rig.runCount(slow.opId), 1);
  });

  it("VM stopped before the cell read an exit status: the status is read back after the start", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { stdout: "late" });
    await ex.start(a.opId, 1);
    await rig.settle(); // exit written on the disk, cell has not polled
    assert.equal(rig.cell.inspect().ops.get(a.opId)!.status.status, "running");
    await rig.cell.stopVm();
    await rig.cell.startVm();
    assert.equal(expectStatus(await ex.status(a.opId), "done").result.stdout, "late");
  });

  it("a dispatching operation whose launch never happened is launched once after a VM restart", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    rig.cell.crashAt("start:dispatching-written");
    await assert.rejects(ex.start(a.opId, 1), CellCrashedError);
    await rig.cell.restart(); // VM up: relaunch happens here
    await rig.settle();
    await rig.cell.stopVm();
    await rig.cell.startVm();
    expectStatus(await ex.status(a.opId), "done");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("never launches on a guess: unknown stays unknown and a copy of start runs nothing", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { hold: "a" });
    await ex.start(a.opId, 1);
    await rig.cell.stopVm();
    await rig.cell.startVm();
    expectStatus(await ex.status(a.opId), "unknown");
    const dup = await ex.start(a.opId, 1);
    assert.deepEqual(dup, { kind: "duplicate", status: { status: "unknown" } });
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("host lost with unsaved disks: new incarnation; operations without a recorded result are unknown", async () => {
    const { rig, ex } = await setup();
    const done = await runOne(rig, "done");
    await ex.status(done.opId); // the cell records the result
    const open = await prepareOp(rig, ex, "s1", "open", { hold: "open" });
    await ex.start(open.opId, 1);
    rig.vm.loseHost();
    rig.vm.start();
    assert.equal(await incarnation(rig), 2);
    expectStatus(await ex.status(done.opId), "done");
    expectStatus(await ex.status(open.opId), "unknown");
  });

  it("older save restored: new incarnation; every operation without a recorded result is unknown", async () => {
    const { rig, ex } = await setup();
    const open = await prepareOp(rig, ex, "s1", "open", { hold: "open" });
    await ex.start(open.opId, 1);
    await rig.cell.stopVm();
    await rig.cell.restoreDisks("save-1");
    await rig.cell.startVm();
    expectStatus(await ex.status(open.opId), "unknown");
  });
});
