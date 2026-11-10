import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testkit } from "@hermesd/guest-helper";
import { GUEST_PROCESS_BACKEND } from "./backend.ts";
import { GuestFixture } from "./fixture.ts";

const { waitFor } = testkit;

describe(`D15 crash after the command started, before the helper answered (backend ${GUEST_PROCESS_BACKEND})`, () => {
  for (const point of ["after_unit_start", "after_launched_write"] as const) {
    it(`${point}: reconciliation adopts the unit; the retry returns running, then the result; one run`, async (t) => {
      const fx = new GuestFixture();
      t.after(() => fx.cleanup());
      const crashed = await fx.launch(fx.gated(), { HERMESD_TEST_FAULT: point });
      assert.equal(crashed.signal, "SIGKILL");
      assert.equal(crashed.response, undefined, "the helper never answered");

      // The command started on its own.
      await fx.untilClaimed();
      await waitFor(() => fx.runs === 1, "the command to start");

      // The new helper reconciles, then the same request comes again.
      const retry = await fx.launch(fx.gated());
      assert.equal(retry.response?.status, "running");
      assert.equal(fx.launchAttempts, 1, "no second launch");
      assert.equal(fx.runs, 1);
      // The journal now has the adopted unit.
      assert.ok(testkit.readJournal(fx.ws).some((r) => r.type === "launched" && r.pid !== -1));

      fx.openGate();
      await fx.untilExit();
      const done = await fx.launch(fx.gated());
      assert.equal(done.response?.status, "done");
      assert.equal(done.response?.exitCode, 0);
      assert.equal(fx.runs, 1);
      assert.equal(fx.launchAttempts, 1);
    });
  }

  it("a failing command is reported as failed with its exit code", async (t) => {
    const fx = new GuestFixture();
    t.after(() => fx.cleanup());
    await fx.launch(`${fx.quick()}; exit 7`, { HERMESD_TEST_FAULT: "after_unit_start" });
    await fx.untilExit();
    const r = (await fx.launch("ignored")).response;
    assert.equal(r?.status, "failed");
    assert.equal(r?.exitCode, 7);
    assert.equal(fx.runs, 1);
  });
});
