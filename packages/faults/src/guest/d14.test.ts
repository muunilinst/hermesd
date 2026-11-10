import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { testkit } from "@hermesd/guest-helper";
import { DEMONSTRATING_BACKENDS } from "../catalogue.ts";
import { GUEST_PROCESS_BACKEND } from "./backend.ts";
import { GuestFixture } from "./fixture.ts";

const { waitFor } = testkit;

function fixture(t: { after(f: () => void): void }): GuestFixture {
  const fx = new GuestFixture();
  t.after(() => fx.cleanup());
  return fx;
}

describe(`D14 launch crashes (backend ${GUEST_PROCESS_BACKEND})`, () => {
  it("is not a demonstrating backend", () => {
    assert.equal((DEMONSTRATING_BACKENDS as ReadonlySet<string>).has(GUEST_PROCESS_BACKEND), false);
  });

  describe("(a) crash after launching, before the unit is submitted", () => {
    it("reports not_launched; the cell launches again; one run", async (t) => {
      const fx = fixture(t);
      const crashed = await fx.launch(fx.quick(), { HERMESD_TEST_FAULT: "after_launching_write" });
      assert.equal(crashed.signal, "SIGKILL");
      assert.equal(crashed.response, undefined);
      assert.equal(fx.launchAttempts, 1);
      assert.equal(fx.hasClaim(), false);

      const s = await fx.status();
      assert.equal(s.response?.status, "not_launched");
      assert.equal(fx.runs, 0);

      const again = await fx.launch(fx.quick());
      assert.equal(again.response?.status, "launched");
      await fx.untilExit();
      assert.equal((await fx.status()).response?.status, "done");
      assert.equal(fx.runs, 1);
      assert.equal(fx.launchAttempts, 2);
    });

    it("also after a reboot: an older boot with no claim is not_launched", async (t) => {
      const fx = fixture(t);
      await fx.launch(fx.quick(), { HERMESD_TEST_FAULT: "after_launching_write", HERMESD_TEST_BOOT_ID: "boot-A" });
      const s = await fx.status({ HERMESD_TEST_BOOT_ID: "boot-B" });
      assert.equal(s.response?.status, "not_launched");
      const again = await fx.launch(fx.quick(), { HERMESD_TEST_BOOT_ID: "boot-B" });
      assert.equal(again.response?.status, "launched");
      await fx.untilExit();
      assert.equal(fx.runs, 1);
    });
  });

  describe("(b) crash after the unit started, before the claim; shim held there", () => {
    it("reports starting; the helper adopts the unit; no second launch; one run", async (t) => {
      const fx = fixture(t);
      const crashed = await fx.launch(fx.quick(), {
        HERMESD_TEST_FAULT: "after_unit_start",
        HERMESD_TEST_SHIM_HOLD_FILE: fx.hold,
      });
      assert.equal(crashed.signal, "SIGKILL");
      await waitFor(() => fs.existsSync(`${fx.hold}.reached`), "shim at the hold");
      assert.equal(fx.hasClaim(), false, "the shim holds before the claim");
      assert.equal(fx.runs, 0);

      const s = await fx.status();
      assert.equal(s.response?.status, "starting");
      // The retried launch must not start a second unit.
      const retry = await fx.launch(fx.quick());
      assert.equal(retry.response?.status, "starting");
      assert.equal(fx.launchAttempts, 1);
      // The helper adopted the unit: the journal now holds a launched record.
      assert.ok(testkit.readJournal(fx.ws).some((r) => r.type === "launched"));

      fs.writeFileSync(fx.hold, "");
      await fx.untilExit();
      assert.equal((await fx.status()).response?.status, "done");
      assert.equal(fx.runs, 1);
      assert.equal(fx.launchAttempts, 1);
    });
  });

  describe("(c) an earlier unit start is delayed; the cell launches again; the earlier start is released", () => {
    it("the two shims race for one claim; one run; the loser runs nothing", async (t) => {
      const fx = fixture(t);
      // Attempt 1: the unit start waits in a queue (invisible to the liveness check, as a systemd job is).
      const first = await fx.launch(fx.gated(), {
        HERMESD_TEST_FAULT: "after_unit_start",
        HERMESD_TEST_QUEUE_HOLD_FILE: fx.queueHold,
      });
      assert.equal(first.signal, "SIGKILL");
      assert.equal(fx.hasClaim(), false);

      // The helper cannot see a unit, so the answer is not_launched and the cell may launch again.
      assert.equal((await fx.status()).response?.status, "not_launched");
      const second = await fx.launch(fx.gated());
      assert.equal(second.response?.status, "launched");
      await fx.untilClaimed();
      await waitFor(() => fx.runs === 1, "the command to start");
      assert.equal(fx.launchAttempts, 2);

      // Release the earlier start while the winner still runs.
      fs.writeFileSync(fx.queueHold, "");
      await waitFor(() => fs.existsSync(fx.L.lost(fx.opId, `hermesd-op-${fx.opId}-1`)), "the loser to give up");
      assert.equal(fx.runs, 1);

      fx.openGate();
      await fx.untilExit();
      assert.equal((await fx.status()).response?.status, "done");
      assert.equal(fx.runs, 1);
      const claim = JSON.parse(fs.readFileSync(fx.L.claim(fx.opId), "utf8"));
      assert.equal(claim.unit, `hermesd-op-${fx.opId}-2`, "the later launch won the claim");
    });

    it("the other order: the delayed start wins the claim and the later shim runs nothing", async (t) => {
      const fx = fixture(t);
      await fx.launch(fx.quick(), { HERMESD_TEST_FAULT: "after_unit_start", HERMESD_TEST_QUEUE_HOLD_FILE: fx.queueHold });
      assert.equal((await fx.status()).response?.status, "not_launched");
      // The second launch is itself held before the claim.
      await fx.launch(fx.quick(), { HERMESD_TEST_SHIM_HOLD_FILE: fx.hold });
      await waitFor(() => fs.existsSync(`${fx.hold}.reached`), "second shim at the hold");
      fs.writeFileSync(fx.queueHold, ""); // the earlier start runs now and claims
      await fx.untilExit();
      assert.equal(fx.runs, 1);
      fs.writeFileSync(fx.hold, ""); // the later shim now finds the claim
      await waitFor(() => fs.existsSync(fx.L.lost(fx.opId, `hermesd-op-${fx.opId}-2`)), "the loser to give up");
      assert.equal(fx.runs, 1);
      assert.equal((await fx.status()).response?.status, "done");
    });
  });

  describe("(d) crash after the claim; the evidence of the end is removed", () => {
    it("reports unknown when the exit status is removed; nothing launches again", async (t) => {
      const fx = fixture(t);
      await fx.launch(fx.quick(), { HERMESD_TEST_FAULT: "after_unit_start" });
      await fx.untilExit();
      fs.rmSync(fx.L.opDir(fx.opId), { recursive: true });
      assert.equal(fx.hasExit(), false);

      const s = await fx.status();
      assert.equal(s.response?.status, "unknown");
      const retry = await fx.launch(fx.quick());
      assert.equal(retry.response?.status, "unknown");
      assert.equal(fx.launchAttempts, 1);
      assert.equal(fx.runs, 1);
    });

    it("reports unknown when the unit died with no exit status", async (t) => {
      const fx = fixture(t);
      await fx.launch(fx.gated(), { HERMESD_TEST_FAULT: "after_unit_start" });
      await fx.untilClaimed();
      await waitFor(() => fx.runs === 1, "the command to start");
      testkit.killWorkspaceProcesses(fx.ws);
      await waitFor(async () => (await fx.status()).response?.status !== "running", "the unit to end");
      assert.equal((await fx.status()).response?.status, "unknown");
      assert.equal((await fx.launch(fx.gated())).response?.status, "unknown");
      assert.equal(fx.launchAttempts, 1);
      assert.equal(fx.runs, 1);
    });

    it("reports unknown for a claim from an older boot with no exit status", async (t) => {
      const fx = fixture(t);
      await fx.launch(fx.gated(), { HERMESD_TEST_FAULT: "after_unit_start", HERMESD_TEST_BOOT_ID: "boot-A" });
      await fx.untilClaimed();
      await waitFor(() => fx.runs === 1, "the command to start");
      testkit.killWorkspaceProcesses(fx.ws);
      const s = await fx.status({ HERMESD_TEST_BOOT_ID: "boot-B" });
      assert.equal(s.response?.status, "unknown");
      assert.equal((await fx.launch(fx.gated(), { HERMESD_TEST_BOOT_ID: "boot-B" })).response?.status, "unknown");
      assert.equal(fx.launchAttempts, 1);
      assert.equal(fx.runs, 1);
    });

    it("reports unknown, and does not launch, when the unit state cannot be read", async (t) => {
      const fx = fixture(t);
      await fx.launch(fx.quick(), { HERMESD_TEST_FAULT: "after_launching_write" });
      const env = { HERMESD_TEST_UNIT_UNREADABLE: "1" };
      assert.equal((await fx.status(env)).response?.status, "unknown");
      assert.equal((await fx.launch(fx.quick(), env)).response?.status, "unknown");
      assert.equal(fx.launchAttempts, 1);
      assert.equal(fx.runs, 0);
    });
  });
});
