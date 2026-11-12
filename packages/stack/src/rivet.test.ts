import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { RivetUnavailable, createRivetStack } from "./rivet.ts";
import { SCENARIOS } from "./scenarios.ts";
import { benchScript } from "./world.ts";

/** A skip is not a pass: it names the reason. */
async function guarded(t: { skip(reason: string): void }, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RivetUnavailable) return t.skip(e.message);
    throw e;
  }
}

describe("stack scenarios on rivetkit 3.0.7", { timeout: 120_000 }, () => {
  for (const sc of SCENARIOS) {
    it(`${sc.fault ? `${sc.fault}: ` : ""}${sc.name}`, { timeout: 120_000 }, (t) => guarded(t, () => sc.run(createRivetStack)));
  }

  it("an eviction raises the owner epoch of s1", { timeout: 120_000 }, (t) =>
    guarded(t, async () => {
      const s = await createRivetStack({ script: [{ reply: "x" }] });
      try {
        const epoch = () => s.epochOf("s1");
        const e1 = await epoch();
        await s.evict("s1");
        assert.ok((await epoch()) > e1, "the epoch rose");
        // The new activation works.
        await s.send("hello");
        assert.equal((await s.waitReplies(1))[0]!.text, "x");
      } finally {
        await s.close();
      }
    }),
  );

  // The engine keeps its store across processes. A run that ends with a turn open (here: the process exits
  // without closing the stack) leaves its wake timer there, and the engine of the next run wakes that actor
  // under the new registry. Without a guard the ghost raised its own owner epoch, wrote to the new run's
  // sweeper under the id "s1" and fenced the live session ("stale epoch for s1"): the bench stalled on a
  // turn that never opened.
  it("an actor left armed by an earlier process does not disturb the next stack", { timeout: 120_000 }, (t) =>
    guarded(t, async () => {
      // The one place a store is shared on purpose: both processes get this directory, nothing else does.
      const shared = mkdtempSync(join(tmpdir(), "hermesd-rivet-shared-"));
      try {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL("./rivet-leave-armed.ts", import.meta.url)), shared], { encoding: "utf8", timeout: 60_000 });
      if (!child.stdout.includes("ARMED")) {
        const err = child.stderr;
        if (/registry is not ready|could not start/.test(err)) return t.skip("rivetkit could not start in the helper process");
        throw new Error(`the helper did not arm a timer: ${err.slice(-500)}`);
      }

      const s = await createRivetStack({ storagePath: shared, script: benchScript(3, 1) });
      try {
        // Observe the stale wake: the engine wakes the old actors under this registry and the guard destroys them.
        // Wait for it while this stack is active, then run turns. Without the guard the ghost has raised its own
        // epoch and fenced the live session by now.
        const end = Date.now() + 60_000;
        while (s.ghostsDestroyed() === 0) {
          if (Date.now() > end) throw new Error("the engine never woke the actor left armed by the earlier process");
          await new Promise((r) => setTimeout(r, 50));
        }
        for (let i = 0; i < 3; i++) {
          await s.send(`turn ${i}`);
          assert.equal((await s.waitReplies(i + 1, 20_000))[i]!.text, `done ${i}`);
        }
        const epochs = await s.rows("s1", "SELECT v FROM host_meta WHERE k = 'owner_epoch'");
        assert.equal(Number((epochs[0] as { v: number }).v), 1, "no other activation of s1 raised the epoch");
      } finally {
        await s.close();
      }
      } finally {
        rmSync(shared, { recursive: true, force: true });
      }
    }),
  );

  it("a stack keeps its data in a private store that close removes, and leaves the environment alone", { timeout: 120_000 }, (t) =>
    guarded(t, async () => {
      const prior = process.env["RIVETKIT_STORAGE_PATH"];
      const s = await createRivetStack({ script: [{ reply: "x" }] });
      const used = s.storagePath;
      try {
        assert.ok(used.includes("hermesd-rivet-"), `a temporary store, not ~/.rivetkit: ${used}`);
        assert.equal(process.env["RIVETKIT_STORAGE_PATH"], prior, "the variable is not held after the start");
        await s.send("hi");
        await s.waitReplies(1);
        assert.ok(readdirSync(used).length > 0, "the engine wrote into the stack's own store");
        assert.ok(s.liveActivations() > 0);
      } finally {
        await s.close();
      }
      assert.equal(existsSync(used), false, "the store is removed on close");
      assert.equal(process.env["RIVETKIT_STORAGE_PATH"], prior, "the environment is as it was");
      assert.equal(s.liveActivations(), 0, "every activation gave its host mirror back when it stopped");
    }),
  );

  it("a second stack in the same process is refused while the first is open, and works after it closed", { timeout: 120_000 }, (t) =>
    guarded(t, async () => {
      const prior = process.env["RIVETKIT_STORAGE_PATH"];
      const a = await createRivetStack({ script: [{ reply: "a" }] });
      try {
        await assert.rejects(createRivetStack({ script: [{ reply: "b" }] }), /another rivet stack is open/);
        await a.send("x");
        assert.equal((await a.waitReplies(1))[0]!.text, "a", "the open stack is not disturbed");
      } finally {
        await a.close();
      }
      const b = await createRivetStack({ script: [{ reply: "b" }] });
      try {
        assert.notEqual(a.storagePath, b.storagePath);
        await b.send("x");
        assert.equal((await b.waitReplies(1))[0]!.text, "b");
        assert.ok(readdirSync(b.storagePath).length > 0);
      } finally {
        await b.close();
      }
      assert.equal(process.env["RIVETKIT_STORAGE_PATH"], prior);
    }),
  );

  it("an alarm with nothing due is the activation's first event, so a cold-wake sample is not credited to the send", { timeout: 120_000 }, (t) =>
    guarded(t, async () => {
      const s = await createRivetStack({ script: [{ reply: "x" }], autoSweep: false });
      try {
        await s.evict("profile");
        await s.resetMeters();
        await s.emptyAlarm("profile");
        await s.call("profile", "register_session", { session: "s1" });
        const m = await s.meter("profile");
        assert.equal(m.activations, 1);
        assert.deepEqual(m.firstEvents, ["alarm"]);
        assert.equal(m.events, 2, "the alarm and the call, once each");
      } finally {
        await s.close();
      }
    }),
  );

  it("a stopped activation's open spans end, and the replacement's do not", { timeout: 120_000 }, (t) =>
    guarded(t, async () => {
      const s = await createRivetStack({ script: [{ reply: "x", hold: "g1" }], autoSweep: false });
      try {
        await s.send("hello");
        const end = Date.now() + 10_000;
        while ((await s.modelArrivals()).length === 0) {
          if (Date.now() > end) throw new Error("the model never saw the request");
          await new Promise((r) => setTimeout(r, 20));
        }
        await s.evict("s1");
        const a = (await s.meter("s1")).busyMs;
        await new Promise((r) => setTimeout(r, 300));
        assert.ok((await s.meter("s1")).busyMs - a < 100, "the dead activation's held request no longer accrues time");
      } finally {
        await s.close();
      }
    }),
  );
});
