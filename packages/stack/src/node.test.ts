import { describe, it } from "node:test";
import { createNodeStack } from "./node.ts";
import { SCENARIOS } from "./scenarios.ts";

for (const mode of ["durable-objects", "rivet"] as const) {
  describe(`stack scenarios on node/${mode}`, () => {
    for (const sc of SCENARIOS) {
      it(`${sc.fault ? `${sc.fault}: ` : ""}${sc.name}`, () => sc.run((o) => createNodeStack(o, mode)));
    }
  });
}
