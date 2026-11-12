import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBench } from "./bench.ts";
import { durableObjectsCost } from "./cost.ts";
import { createNodeStack } from "./node.ts";
import { assertReadOnlySql } from "./readonly-sql.ts";
import { SCENARIOS } from "./scenarios.ts";

for (const mode of ["durable-objects", "rivet"] as const) {
  describe(`stack scenarios on node/${mode}`, () => {
    for (const sc of SCENARIOS) {
      it(`${sc.fault ? `${sc.fault}: ` : ""}${sc.name}`, () => sc.run((o) => createNodeStack(o, mode)));
    }
  });
}

describe("Stack.cron on node", () => {
  it("runs only the named job and does not move the clock", async () => {
    const s = await createNodeStack({ script: [{ reply: "x" }] });
    try {
      const before = Date.now();
      await s.cron("tick");
      await s.cron("sweep");
      assert.ok(Date.now() - before < 5_000);
      assert.equal((await s.meter("sweeper")).events, 2, "two events, one per named job");
    } finally {
      await s.close();
    }
  });
});

describe("assertReadOnlySql", () => {
  it("accepts one SELECT or WITH ... SELECT and refuses the rest", () => {
    assert.equal(assertReadOnlySql("SELECT 1;"), "SELECT 1");
    assert.equal(assertReadOnlySql("select ';' as x"), "select ';' as x");
    assert.equal(assertReadOnlySql("WITH t AS (SELECT 1 a) SELECT a FROM t"), "WITH t AS (SELECT 1 a) SELECT a FROM t");
    for (const bad of ["SELECT 1; DELETE FROM turns", "SELECT 1;;", "DELETE FROM x", "WITH t AS (SELECT 1) DELETE FROM x", "PRAGMA writable_schema = 1", "SELECT 'unterminated", "/* c */ DROP TABLE x"]) {
      assert.throws(() => assertReadOnlySql(bad), /./, bad);
    }
  });
});

describe("bench on node", () => {
  it("counts a turn and prices it", async () => {
    const r = await runBench((o) => createNodeStack(o), { turns: 4, coldSamples: 1 });
    assert.equal(r.turns, 4);
    assert.equal(r.modelCallsPerTurn, 1.5, "two plain turns and two tool turns");
    assert.ok(r.perTurn.commits > 0 && r.perTurn.rowsChanged > 0);
    assert.ok(durableObjectsCost(r).total > 0);
  });
});
