import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testkit } from "@hermesd/guest-helper";
import { GUEST_PROCESS_BACKEND } from "./backend.ts";
import { GuestFixture } from "./fixture.ts";

const { waitFor, runHelper } = testkit;

/**
 * D16, the helper side. The executor cell's owner node dies while an
 * operation is dispatching. The new owner knows only the op_id. It asks the
 * helper for status(op_id) and acts on the answer. Here the "cell" is the
 * test, and the helper is killed at the point where the old owner's request
 * was in flight.
 */
describe(`D16 helper side: dispatching resolved from the journal (backend ${GUEST_PROCESS_BACKEND})`, { skip: testkit.needsLinux }, () => {
  it("not_found: the journal entry was never written; the cell launches; one run", async (t) => {
    const fx = new GuestFixture();
    t.after(() => fx.cleanup());
    const s = await fx.status();
    assert.equal(s.response?.status, "not_found");
    assert.equal((await fx.launch(fx.quick())).response?.status, "launched");
    await fx.untilExit();
    assert.equal((await fx.status()).response?.status, "done");
    assert.equal(fx.runs, 1);
  });

  it("launching only: status is not_launched; the cell launches; one run", async (t) => {
    const fx = new GuestFixture();
    t.after(() => fx.cleanup());
    await fx.launch(fx.quick(), { HERMESD_TEST_FAULT: "after_launching_write" });
    assert.equal((await fx.status()).response?.status, "not_launched");
    await fx.launch(fx.quick());
    await fx.untilExit();
    assert.equal(fx.runs, 1);
    assert.equal((await fx.status()).response?.status, "done");
  });

  for (const point of ["after_unit_start", "after_launched_write"] as const) {
    it(`${point}: the answer was lost; status finds the running command; the cell does not launch again`, async (t) => {
      const fx = new GuestFixture();
      t.after(() => fx.cleanup());
      await fx.launch(fx.gated(), { HERMESD_TEST_FAULT: point });
      await fx.untilClaimed();
      await waitFor(() => fx.runs === 1, "the command to start");

      assert.equal((await fx.status()).response?.status, "running");
      fx.openGate();
      await fx.untilExit();
      const done = await fx.status();
      assert.equal(done.response?.status, "done");
      assert.equal(fx.launchAttempts, 1);
      assert.equal(fx.runs, 1);
    });
  }

  it("the unit state cannot be read: status is unknown; the cell does not launch", async (t) => {
    const fx = new GuestFixture();
    t.after(() => fx.cleanup());
    await fx.launch(fx.quick(), { HERMESD_TEST_FAULT: "after_launching_write" });
    const s = await fx.status({ HERMESD_TEST_UNIT_UNREADABLE: "1" });
    assert.equal(s.response?.status, "unknown");
    assert.equal(fx.runs, 0);
    assert.equal(fx.launchAttempts, 1);
  });

  it("the boot handshake reports a journal sequence that rises with every journal write", async (t) => {
    const fx = new GuestFixture();
    t.after(() => fx.cleanup());
    const seqOf = async () => ((await runHelper(fx.ws, ["handshake"])).answer as { journalSeq: number }).journalSeq;
    assert.equal(await seqOf(), 0);
    await fx.launch(fx.quick(), { HERMESD_TEST_FAULT: "after_launching_write" });
    const s1 = await seqOf();
    assert.ok(s1 >= 1);
    await fx.launch(fx.quick());
    await fx.untilExit();
    await fx.status();
    const s2 = await seqOf();
    assert.ok(s2 > s1);
    assert.equal(await seqOf(), s2, "a handshake with nothing to reconcile writes nothing");
  });
});
