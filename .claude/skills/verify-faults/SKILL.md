---
name: verify-faults
description: Verify the hermesd fault-test catalogue D1 to D17 (crash recovery at every handoff) on the backends available locally, which are the in-memory executor model, the in-memory Node host in Durable Objects and Rivet rule sets, and the guest-process helper on Linux. Use after any change to recovery behaviour, to packages/faults, or before editing STATUS.md.
---

# Verify the fault tests (guide 7.3, 7.4)

Shared launch, doctor, evidence and cleanup: [verify](../verify/SKILL.md). Decision record:
[ADR 0010](../../../docs/adr/0010-verification-specified-is-not-demonstrated.md).

Each test injects one failure and states what must be true afterwards. The catalogue
(`packages/faults/src/catalogue.ts`) is the list from the guide; `definitions.ts` holds the
backend-agnostic cases; a backend binds them to a world.

## Sub-features

| Tests | Where | Backend |
| --- | --- | --- |
| D2, D4, D5, D10, D11 (a) to (e), D13, D17 | `model-backend.test.ts` | `model` |
| D3, D6, D8, D9 (a) to (h), D12, inbox crash, two parallel Rivet actions | `actor/` | `node` |
| D1, D7, cancellation at each point, compaction race, handoff, replay, upgrade with old rows, providers | `loop/` | `node` |
| D14 (a) to (d), D15, D16 helper side | `guest/` | `guest-process`, Linux only |
| The catalogue matches the guide and STATUS.md | `catalogue.test.ts` | none |

## How to get to it (user POV)

The "user" is a failure: an owner that dies during a model call, a dropped executor reply, a
webhook delivered twice, a timer that fires early. `runFaultCase(backend, id, caseId)` in
`packages/faults/src/runner.ts` runs one case in a fresh world and returns a result whose
`demonstrated` field is true only on a real host.

## Driving it with verify.ts

```sh
bun .claude/skills/verify/verify.ts run faults              # model and node backends
bun .claude/skills/verify/verify.ts run faults --linux      # adds guest-process (D14 to D16)
```

Proof on macOS: `PASS faults on bun: 297 pass, 0 fail in 22 files`, with the three guest files
listed as skipped. To run one test while you work: `bun test ./packages/faults/src/actor/d9.test.ts`.

## Gotchas

- **Never edit STATUS.md from this run.** Its rule: change a row only in the same change that adds the evidence, and only a real host with a real executor, guest helper and VM makes a mechanism Demonstrated. A new local pass may change a `-` to `pass` in the `model`, `node` or `guest-process` column, nothing else.
- A mock hides "ran but unreported". That is why D2, D4, D10, D14, D15 and D16 must be rerun on a real VM, counting runs from a counter the command increments.
- D9 has eight cases and each one matters; (e), (f) and (g) are rescued by the sweeper alone, with no outbox delivery.
- The summary-call crash tests wait for a busy machine; on a loaded laptop the run is slower, not flaky. If one times out, rerun it alone before you look for a bug.
- macOS without `--linux` covers no guest test.
