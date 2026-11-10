import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAULT_TESTS, PHASE0_FAULT_IDS } from "./catalogue.ts";

const status = readFileSync(new URL("../../../STATUS.md", import.meta.url), "utf8");

describe("fault catalogue", () => {
  it("has D1 to D17 in order", () => {
    assert.deepEqual(
      FAULT_TESTS.map((t) => t.id),
      Array.from({ length: 17 }, (_, i) => `D${i + 1}`),
    );
  });

  it("has every sub-case the guide requires", () => {
    const counts = Object.fromEntries(FAULT_TESTS.filter((t) => t.cases).map((t) => [t.id, t.cases!.length]));
    assert.deepEqual(counts, { D9: 8, D11: 5, D14: 4 });
  });

  it("puts the executor tests of milestone 1 step 2 in phase 0", () => {
    assert.deepEqual(PHASE0_FAULT_IDS, ["D2", "D4", "D5", "D10", "D11", "D13", "D14", "D15", "D16", "D17"]);
  });

  it("has one STATUS.md row per test, with the same phase", () => {
    for (const t of FAULT_TESTS) {
      assert.match(status, new RegExp(`^\\| ${t.id} \\| ${t.phase} \\|`, "m"));
    }
  });
});
