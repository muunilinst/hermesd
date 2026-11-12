import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCENARIOS } from "./scenarios.ts";
import { createWorkerdStack } from "./workerd.ts";

// Probe once: if Miniflare or the workerd binary cannot start, every test skips with the reason.
let skipReason: string | false = false;
try {
  const s = await createWorkerdStack({ script: [], tickEveryMs: 0 });
  await s.close();
} catch (e) {
  skipReason = `workerd is not available: ${e instanceof Error ? e.message : String(e)}`;
}

describe("stack scenarios on workerd (Durable Objects, real time)", () => {
  for (const sc of SCENARIOS) {
    it(`${sc.fault ? `${sc.fault}: ` : ""}${sc.name}`, { skip: skipReason }, () => sc.run((o) => createWorkerdStack(o)));
  }

  it("an eviction raises the owner epoch", { skip: skipReason }, async () => {
    const s = await createWorkerdStack({ script: [{ reply: "x" }] });
    try {
      const epoch = async () => Number((await s.rows("s1", "SELECT v FROM host_meta WHERE k = 'owner_epoch'"))[0]!["v"]);
      const before = await epoch();
      await s.evict("s1");
      const after = await epoch();
      assert.ok(after > before, `epoch ${after} should be above ${before}`);
    } finally {
      await s.close();
    }
  });
});
