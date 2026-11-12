# 0004. The executor contract: "unknown" is an answer

- Status: Accepted; specified, not demonstrated. Needs a change to TeenyTiny's guest helper
- Date: 2026-11-11
- Source: porting guide rev 5.1, section 3.4

## Context

The actor sends a command to a machine. If it crashes before the command starts, or while it
runs, the record looks the same: no result yet. Only the machine knows whether the build ran.
A runtime that offers only succeeded or failed makes the programmer guess.

A command passes through three hands, and each handoff can lose an answer: the session actor
owns the intent, the executor cell owns the operation's identity, owner, incarnation and
result, and the guest helper owns the launch.

## Decision

**The contract.**

```
prepare(op_id, intent_id, incarnation, input_hash, cmd) -> prepared | duplicate(status) | conflict | expired
start(op_id, owner_epoch)   -> accepted | duplicate(status) | stale_epoch | expired
status(op_id)               -> prepared | dispatching | running | done(result) | failed | cancelled | unknown | expired
cancel(op_id, owner_epoch)  -> stopped | already_done | not_found | unknown | stale_epoch
ack(op_id, owner_epoch)     -> output dropped; the tombstone stays
fence(session, owner_epoch) -> raises the session's minimum epoch; returns every non-terminal operation
describe(workspace)         -> the current incarnation
```

**Identity is derived.** `op_id = H(tenant, session, intent_id)`, where the intent ID is the
tool call's `tool_call_uid`. Losing a response never loses the identity. Authority is separate:
the owner epoch is an argument, never part of the ID.

**Prepare is idempotent.** Same `op_id` and `input_hash` gives `duplicate(status)`; a different
hash gives `conflict`.

**Takeover adopts.** A new owner commits its higher epoch, then calls `fence`. For each open
operation it acts once: `prepared` means it calls `start` with its own epoch; `dispatching` or
`running` means it becomes the owner and receives the result; `done` or `failed` is recorded
and acknowledged. A call below the minimum epoch gets `stale_epoch`.

**Dispatch is uncertain.** The caller never records "sent". It retries with the same `op_id`.

**An incarnation binds an operation.** The cell keeps a workspace incarnation, an integer that
only increases. At the first boot handshake of every new VM run it starts a new incarnation
unless it can prove continuity (the VM's current save is the one recorded at the last stop of a
run this executor served, same lineage, no restore, image replacement, discard or recovery
between). When in doubt it advances: a spurious advance costs `unknown` results for operations
in flight; a missed one can re-run a command. An operation bound to a lower incarnation is
`expired`. The guest's journal sequence is an extra check only: a lower value proves a
rollback, an equal or higher one proves nothing.

**The guest launch.** The helper, in order: (1) answers from the journal if it has the
`op_id`; (2) writes `launching` and syncs; (3) starts a unit whose first process is a shim that
creates a claim file with `O_CREAT | O_EXCL`, syncs it, and only then runs the command; (4)
writes `launched` and answers. Exactly one shim can create the claim, so the command runs at
most once. After a restart the helper reconciles each open entry from the journal, the claim
file, the unit state and the boot ID to `not_launched`, `starting`, `running`, `done`,
`failed` or `unknown`. The executor never relaunches on a guess.

**Retention.** Output is kept until `ack`, with a floor of 7 days. After `ack` a tombstone
stays for the life of the incarnation.

## Consequences

- A retry after any lost message finds the first attempt.
- `unknown` reaches the user: the turn's admission becomes `unknown` and later inputs wait.
- The log keeps the knowledge of a command; it does not keep the command alive through every failure. A VM stop ends a running command.
- Fencing has one window left: an old owner's running command can change files until it is cancelled or ends. The contract makes the window visible.
- This is a TeenyTiny feature, not only an agent component. Open: whether TeenyTiny takes the guest helper change, and whether receipts live in the VM's namespace cell or a dedicated one.

## How we check it

`packages/executor-protocol` is the contract and `deriveOpId`. `packages/executor-model` is a
reference cell and a simulated VM lifecycle. `packages/guest-helper` is a prototype helper with
a real journal, claim file and child processes. Fault tests D2, D4, D5, D10, D11 (a) to (e),
D13 to D17 decide it; they pass on the model and on `guest-process`, which is not a
demonstration. "One run" is counted from a counter the command increments. Drive it with the
`verify-executor` skill.
