import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAULT_TESTS, DEMONSTRATING_BACKENDS } from "./catalogue.ts";
import type { Backend } from "./catalogue.ts";
import type { FaultBackend } from "./backend.ts";
import { FAULT_DEFINITIONS } from "./definitions.ts";
import { modelBackend } from "./model-backend.ts";
import { countsAsDemonstrated, labelResult, runAllFaultTests, runFaultCase } from "./runner.ts";

describe("fault definitions", () => {
  it("cover D2, D4, D5, D10, D11 (a to e), D13 and D17", () => {
    assert.deepEqual(
      FAULT_DEFINITIONS.map((d) => d.id),
      ["D2", "D4", "D5", "D10", "D11", "D13", "D17"],
    );
    const d11 = FAULT_DEFINITIONS.find((d) => d.id === "D11")!;
    assert.deepEqual(d11.cases.map((c) => c.caseId), ["a", "b", "c", "d", "e"]);
  });

  it("match the case lists of the catalogue", () => {
    for (const def of FAULT_DEFINITIONS) {
      const cat = FAULT_TESTS.find((t) => t.id === def.id)!;
      assert.deepEqual(
        def.cases.map((c) => c.caseId),
        cat.cases ? cat.cases.map((c) => c.id) : [undefined],
        def.id,
      );
    }
  });
});

describe("fault tests on the model backend", () => {
  for (const def of FAULT_DEFINITIONS) {
    for (const c of def.cases) {
      const name = `${def.id}${c.caseId ? `(${c.caseId})` : ""}`;
      it(`${name} passes [model]`, async () => {
        const r = await runFaultCase(modelBackend, def.id, c.caseId);
        assert.equal(r.outcome, "pass", r.error);
        assert.equal(r.backend, "model");
      });
    }
  }
});

describe("result labels", () => {
  it("label every result with its backend, and never count a model pass as demonstrated", async () => {
    const results = await runAllFaultTests(modelBackend);
    assert.equal(results.length, 11);
    for (const r of results) {
      assert.equal(r.backend, "model");
      assert.equal(r.demonstrated, false);
      assert.match(labelResult(r), /@model: pass \(not demonstrated\)$/);
    }
  });

  it("count a pass as demonstrated only on a demonstrating backend", () => {
    assert.equal(countsAsDemonstrated("model"), false);
    assert.equal(countsAsDemonstrated("node"), false);
    for (const b of DEMONSTRATING_BACKENDS) assert.equal(countsAsDemonstrated(b), true);
  });

  it("mark a pass on a real backend as demonstrated", async () => {
    const real = (name: Backend): FaultBackend => ({ name, create: () => modelBackend.create() });
    const r = await runFaultCase(real("teenytiny-1node"), "D4");
    assert.equal(r.demonstrated, true);
    assert.match(labelResult(r), /^D4@teenytiny-1node: pass \(demonstrated\)$/);
  });
});

describe("the tests can fail", () => {
  it("fail when the run counter shows a second run", async () => {
    const broken: FaultBackend = {
      name: "model",
      async create() {
        const world = await modelBackend.create();
        return { ...world, runCount: async (id) => (await world.runCount(id)) + 1 };
      },
    };
    for (const id of ["D2", "D4", "D5", "D10", "D13", "D17"] as const) {
      const r = await runFaultCase(broken, id);
      assert.equal(r.outcome, "fail", id);
      assert.equal(r.demonstrated, false);
      assert.match(labelResult(r), /: fail$/);
    }
  });
});
