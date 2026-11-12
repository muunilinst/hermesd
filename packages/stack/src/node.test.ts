import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBench } from "./bench.ts";
import { durableObjectsCost } from "./cost.ts";
import { createNodeStack } from "./node.ts";
import { SCENARIOS } from "./scenarios.ts";

for (const mode of ["durable-objects", "rivet"] as const) {
  describe(`stack scenarios on node/${mode}`, () => {
    for (const sc of SCENARIOS) {
      it(`${sc.fault ? `${sc.fault}: ` : ""}${sc.name}`, () => sc.run((o) => createNodeStack(o, mode)));
    }
  });
}

describe("bench on node", () => {
  it("counts a turn and prices it", async () => {
    const r = await runBench((o) => createNodeStack(o), { turns: 4, coldSamples: 1 });
    assert.equal(r.turns, 4);
    assert.equal(r.modelCallsPerTurn, 1.5, "two plain turns and two tool turns");
    assert.ok(r.perTurn.commits > 0 && r.perTurn.rowsChanged > 0);
    assert.ok(durableObjectsCost(r).total > 0);
  });
});
