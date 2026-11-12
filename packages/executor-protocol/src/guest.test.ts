import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileLaunch, type LaunchEvidence } from "./guest.ts";

const same = { olderBoot: false, exitStatusWritten: false } as const;

// One row per line of the reconciliation table in section 3.4.
const rows: [string, LaunchEvidence, string][] = [
  ["launching, no claim, no live unit", { ...same, claimFile: false, unitAlive: false }, "not_launched"],
  ["launching, no claim, unit alive", { ...same, claimFile: false, unitAlive: true }, "starting"],
  ["claim, unit alive", { ...same, claimFile: true, unitAlive: true }, "running"],
  ["exit 0 written", { ...same, claimFile: true, unitAlive: false, exitStatusWritten: true, exitCode: 0 }, "done"],
  ["exit 1 written", { ...same, claimFile: true, unitAlive: false, exitStatusWritten: true, exitCode: 1 }, "failed"],
  ["claim, no live unit, no exit status", { ...same, claimFile: true, unitAlive: false }, "unknown"],
  ["no claim, unit state unreadable", { ...same, claimFile: false, unitAlive: undefined }, "unknown"],
  ["older boot, claim, no exit status", { olderBoot: true, claimFile: true, unitAlive: false, exitStatusWritten: false }, "unknown"],
  ["older boot, no claim", { olderBoot: true, claimFile: false, unitAlive: undefined, exitStatusWritten: false }, "not_launched"],
];

describe("reconcileLaunch", () => {
  for (const [name, evidence, expected] of rows) {
    it(name, () => assert.equal(reconcileLaunch(evidence), expected));
  }

  it("never answers not_launched when a claim file exists", () => {
    for (const olderBoot of [false, true])
      for (const unitAlive of [true, false, undefined])
        assert.notEqual(reconcileLaunch({ olderBoot, claimFile: true, unitAlive, exitStatusWritten: false }), "not_launched");
  });
});
