---
name: verify-executor
description: Verify the hermesd executor contract (prepare, start, status, cancel, ack, fence, describe), derived operation IDs, the in-memory executor cell and VM lifecycle model, and the prototype guest helper with its launch journal, O_EXCL claim file and reconciliation. Use after a change to packages/executor-protocol, executor-model or guest-helper, or to the guest fault tests D14 to D16.
---

# Verify the executor and the guest helper (guide 3.4)

Shared launch, doctor, evidence and cleanup: [verify](../verify/SKILL.md). Decision record:
[ADR 0004](../../../docs/adr/0004-executor-contract-unknown-is-an-answer.md).

A shell command passes through three hands: the session actor (the intent), the executor cell
(identity, owner, incarnation, result), and the guest helper (the launch). Each handoff can
lose an answer, so `unknown` is a real status and nothing relaunches on a guess.

## Sub-features

- **executor-protocol**: the contract types, `deriveOpId` (`op_id = H(tenant, session, intent_id)`), and the guest reconciliation table.
- **executor-model** (`cell.test.ts`, `lifecycle.test.ts`, `link.test.ts`): the reference cell (idempotent prepare, conflict, expired, epochs, fence and adoption, tombstones), the simulated VM lifecycle that advances the workspace incarnation, and a link that drops and copies messages.
- **guest-helper** (`journal.test.ts`, `shim.test.ts`, `units.test.ts`): the journal, the shim that creates the claim file with `O_CREAT | O_EXCL` before it runs the command, and unit management.
- **Guest fault tests** (`packages/faults/src/guest`): D14 (a) to (d), D15, D16 on backend `guest-process`: real child processes and files, no systemd, no VM.
- **Model fault tests** (`packages/faults/src/model-backend.test.ts`): D2, D4, D5, D10, D11 (a) to (e), D13, D17 on backend `model`.

## How to get to it (user POV)

The guest helper has a one-shot CLI. It answers with one JSON line.

```sh
bun packages/guest-helper/src/cli.ts <workspace> handshake
bun packages/guest-helper/src/cli.ts <workspace> launch <op_id> <incarnation> <cmd>
bun packages/guest-helper/src/cli.ts <workspace> status <op_id>
bun packages/guest-helper/src/cli.ts <workspace> reconcile
```

Set `HERMESD_UNIT_MANAGER=process` where systemd is not PID 1. The `HERMESD_TEST_*` variables
in the header of `cli.ts` inject faults; use them only in a fault test.

## Driving it with verify.ts

```sh
bun .claude/skills/verify/verify.ts run executor            # macOS: model and protocol only
bun .claude/skills/verify/verify.ts run executor --linux    # everything, in the pinned oven/bun container
```

On Linux the run then drives the real CLI in a scratch workspace:
- `handshake`: the answer must carry a boot ID.
- `launch op-verify-1` with a command that appends one line to a counter file: it must answer `launched` or `done`.
- The same `launch` again, the same command, as a real retry: it must answer `starting`, `launched`, `running` or `done` for the same op (`starting` when it lands before the shim claimed: the helper adopts the unit). `unknown`, `not_launched` or `failed` fails it.
- `status`, repeated for up to 15 s until it says `done` with exit code 0. Then it waits 1 s for anything late and counts the lines: exactly one, so the command ran once over both launches.

Proof:
`PASS executor on bun: 127 pass, 0 fail ... 4/4 drives`, and the JSON answers in
`drive-guest-*.log` (`launched`, then `done` with `exitCode: 0`).

## Gotchas

- **macOS skips the guest.** `shim.test.ts`, `units.test.ts`, `faults/src/guest/*` and the four drives need Linux (`/proc`, `/proc/sys/kernel/random/boot_id`). Without `--linux` the run passes on the rest and lists what it skipped. A macOS-only pass does not cover the guest helper.
- The container has no systemd, so the helper uses the process-group unit manager. `SystemdUnitManager` (transient units, cgroups) is not exercised anywhere yet.
- "One run" is counted from a file the command itself writes, never from the journal or the claim file. Keep that rule when you add a drive (guide 7.3).
- Backends `model` and `guest-process` never demonstrate a mechanism. Phase 0 needs a real executor cell, a real guest helper and a real VM.
- The guest D14 to D16 tests take about a minute: they wait on real process timeouts.
