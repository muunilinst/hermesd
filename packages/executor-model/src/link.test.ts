import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CallerCrashedError, MessageDelayedError, ReplyLostError } from "./errors.ts";
import { ModelRig } from "./rig.ts";
import { boot, prepareOp } from "./testing.ts";

async function setup() {
  const rig = new ModelRig();
  await boot(rig);
  return { rig, ex: rig.link() };
}

describe("fault link", () => {
  it("drops a reply after the effect, and the retry finds the kept result", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { stdout: "kept" });
    ex.dropReplyNext("start");
    await assert.rejects(ex.start(a.opId, 1), ReplyLostError);
    await rig.settle();
    assert.equal((await ex.start(a.opId, 1)).kind, "duplicate");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("crashes the caller after the send", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    ex.crashCallerAfterSendNext("start");
    await assert.rejects(ex.start(a.opId, 1), CallerCrashedError);
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("delays a message and delivers it later as a duplicate", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    const held = ex.delayNext("start");
    await assert.rejects(ex.start(a.opId, 1), MessageDelayedError);
    assert.equal(rig.runCount(a.opId), 0);
    assert.deepEqual(await ex.start(a.opId, 1), { kind: "accepted" });
    const late = await held.deliverLast().deliver();
    assert.equal((late as { kind: string }).kind, "duplicate");
    assert.equal(rig.runCount(a.opId), 1);
  });

  it("applies a fault once, to the next call of the named method only", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a");
    ex.dropReplyNext("status");
    await ex.start(a.opId, 1);
    await assert.rejects(ex.status(a.opId), ReplyLostError);
    await ex.status(a.opId);
  });

  it("keeps working over a failover of the cell", async () => {
    const { rig, ex } = await setup();
    const a = await prepareOp(rig, ex, "s1", "a", { stdout: "x" });
    await ex.start(a.opId, 1);
    await rig.settle();
    await rig.failover();
    assert.equal((await ex.status(a.opId)).status, "done");
    assert.equal(rig.runCount(a.opId), 1);
  });
});
