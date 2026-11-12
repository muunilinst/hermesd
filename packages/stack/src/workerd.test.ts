import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCENARIOS } from "./scenarios.ts";
import { createWorkerdStack } from "./workerd.ts";

// Probe the runtime alone, with a trivial worker that has nothing of ours in it: if Miniflare or the workerd
// binary cannot start, every test skips with the reason. Bundling or starting the application is not probed
// here, so an error in it fails the tests instead of skipping them.
let skipReason: string | false = false;
try {
  const { Miniflare } = await import("miniflare");
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } };", compatibilityDate: "2026-07-01" } as never);
  try {
    await mf.ready;
    const res = await mf.dispatchFetch("http://probe.test/");
    if ((await res.text()) !== "ok") throw new Error("the probe worker answered wrongly");
  } finally {
    await mf.dispose();
  }
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
      const before = await s.epochOf("s1");
      await s.evict("s1");
      const after = await s.epochOf("s1");
      assert.ok(after > before, `epoch ${after} should be above ${before}`);
    } finally {
      await s.close();
    }
  });
});
