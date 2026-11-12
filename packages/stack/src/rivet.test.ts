import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RivetUnavailable, createRivetStack } from "./rivet.ts";
import { SCENARIOS } from "./scenarios.ts";

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
});
