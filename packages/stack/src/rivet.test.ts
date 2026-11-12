import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
        const epoch = async () => Number(((await s.rows("s1", "SELECT v FROM host_meta WHERE k = 'owner_epoch'"))[0] as { v: number }).v);
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
      const child = spawnSync(process.execPath, [fileURLToPath(new URL("./rivet-leave-armed.ts", import.meta.url))], { encoding: "utf8", timeout: 60_000 });
      if (!child.stdout.includes("ARMED")) {
        const err = child.stderr;
        if (/registry is not ready|could not start/.test(err)) return t.skip("rivetkit could not start in the helper process");
        throw new Error(`the helper did not arm a timer: ${err.slice(-500)}`);
      }

      const turns = 12;
      const s = await createRivetStack({ script: benchScript(turns, 1) });
      try {
        // Long enough for the old timer (retry 1 s) to fire in the new engine several times.
        for (let i = 0; i < turns; i++) {
          await s.send(`turn ${i}`);
          assert.equal((await s.waitReplies(i + 1, 20_000))[i]!.text, `done ${i}`);
        }
        const epochs = await s.rows("s1", "SELECT v FROM host_meta WHERE k = 'owner_epoch'");
        assert.equal(Number((epochs[0] as { v: number }).v), 1, "no other activation of s1 raised the epoch");
      } finally {
        await s.close();
      }
    }),
  );
});
