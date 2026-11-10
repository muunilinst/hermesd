# Notes on the executor model

The model follows section 3.4 of the porting guide (rev 5.1) and the fault
tests of section 7.3. In some places the guide is unclear or says two
things. This file lists each case and the reading that the model uses.
Rule for every choice: the safest reading wins. The executor never
launches again on a guess.

A pass on this model does not demonstrate a mechanism. See `STATUS.md`.

## Ambiguities and the chosen reading

1. **`prepare` has no session.** (3.4, contract) `fence(session, epoch)`
   and the per-session minimum epoch need to know the session of each
   operation, but `prepare(op_id, intent_id, incarnation, input_hash, cmd)`
   does not carry it. The model takes the session from the binding:
   `cell.forSession(session)` returns an `Executor` that tags `prepare`.
   Recommendation: add `session` to the wire form of `prepare`.

2. **What `fence` returns.** (3.4) The contract line says "every operation
   of the session that is not terminal". The rules text says that for
   `done` or `failed` the new owner "records and acknowledges". Both cannot
   hold if `fence` lists only non-terminal operations. The model returns
   every operation of the session that is **not acknowledged**, of any
   status. This is a superset of the first reading. A new owner acts only
   on what it can act on: `prepared` starts, `dispatching` and `running`
   wait, terminal operations are recorded and acknowledged.

3. **Fence with a lower epoch.** (3.4) The text does not say what a fence
   below the current minimum does. The model keeps the higher minimum,
   adopts nothing, and returns the minimum. The caller sees that it is
   behind. `start`, `cancel` and `ack` of that caller give `stale_epoch`.

4. **Adoption.** (3.4) "The new owner becomes its owner." The model sets
   the owner epoch of each open operation to the fence epoch.

5. **Unknown `op_id` in `start`.** (3.4) `start` has no `not_found` answer.
   The model throws a `ProtocolError` for an operation that was never
   prepared. After tombstones of older incarnations were collected, it
   answers `expired`, because the operation may have belonged to them.
   Nothing runs in either case.

6. **Unknown `op_id` in `status`.** (3.4) `status` has no `not_found`
   either. The model answers `unknown`. A missing record does not show
   that nothing ran.

7. **`ack` of an operation that is not terminal.** (3.4) The contract does
   not say. The model reads the guest once and acknowledges if the
   operation is terminal. If it is still not terminal, it throws a
   `ProtocolError`. Output of a running command is never dropped.

8. **Status after ack.** (3.4, 7.3 D11 a) The tombstone keeps "the terminal
   status", but `done` in the contract type has a mandatory `result`. The
   model returns `done` with an empty result (exit code 0, empty output,
   because `done` means exit code 0). For `failed` it returns the reason
   "output dropped". Recommendation: make `result` optional in `OpStatus`.

9. **Status of an operation of an older incarnation.** (3.4) The text says
   operations of the old incarnation "without a result recorded in the
   cell are unknown". It also lists `expired` as a status. The model uses
   both. An operation that was only `prepared` becomes `expired`: it never
   reached the guest, so it never ran. A `dispatching` or `running`
   operation becomes `unknown`. Terminal operations keep their status.
   `prepare` and `start` for any older incarnation give `expired`.

10. **Order of the checks in `start`.** (3.4) The model checks, in this
    order: unknown operation, `stale_epoch`, `expired` by incarnation,
    then duplicate. Authority comes before everything else. A stale owner
    cannot learn the state of an operation.

11. **Order of the checks in `prepare`.** (3.4) The answers are listed as
    duplicate, conflict, expired. The model checks the incarnation first.
    A retry with a lower incarnation is `expired` even when the input hash
    differs, because the operation is refused by number and nothing else
    is read. An incarnation higher than the current one is a caller error
    and throws.

12. **What "candidate" means.** (3.4) The guide says the VM reports "its
    current save with a candidate and a lineage" and does not define
    candidate. The model reads it as a flag: the disks may differ from the
    stored save (it is set after a recovery). A candidate save never proves
    continuity. Continuity needs the same save id, the same lineage and no
    candidate flag.

13. **How the cell sees "no restore_disks, replace_image, discard or
    recovery_required lies between".** (3.4) The guide does not say how the
    cell sees an operation that an operator sent directly. The model uses
    the VM revision, which "advances with every accepted operation". The
    cell records the revision at its own stop. A new run proves continuity
    only if its revision is exactly that value plus one (the start). Any
    other accepted operation in between changes the revision, so it
    advances. A restore to the very save of the last stop also advances.
    This is a spurious advance, which the guide accepts.

14. **First boot.** (3.4) With no earlier run there is nothing to prove.
    The first handshake starts incarnation 1. `describe` throws until the
    cell has checked a run.

15. **When the check runs.** (3.4) "The executor cell does not accept a
    start on a run it has not checked." The model checks before every call,
    not only at the handshake. While the VM is not running, the check
    cannot read the VM. The `start` of an operation then throws
    `VmUnavailableError`, and nothing runs.

16. **Lifecycle through the cell.** (3.4) The cell advances the incarnation
    in the same step as the VM operation for `restore_disks`,
    `replace_image`, `discard` and `recover`, and records the new state as
    the base for the next boot. So a restore through the cell advances once.
    A recovery advances twice (once at the operation, once at the next
    boot, because a candidate save cannot prove continuity). Spurious
    advances are allowed.

17. **Stop through the cell.** (3.4) Before it stops a run, the cell reads
    the result of every open command from the guest. After the stop, a
    command that was running has no exit status unless it wrote one, so it
    is `unknown`. A stop that the cell did not see (operator stop) leaves
    no base, so the next run advances.

18. **Journal sequence.** (3.4) The cell sees the sequence at the handshake
    and in the receipt of its own stop. A lower value than the highest seen
    advances. After any advance the reference value is reset to the new
    one, because a rollback is then accepted as the new history. An equal or
    higher value is never used as proof.

19. **Relaunch.** (3.4) The cell launches again only for an operation in
    `dispatching` when the helper says `not_found` or `not_launched`.
    These are proofs that the command has not run. Every other answer,
    including `unknown` and `starting`, does not launch. A `running` record
    that the helper does not know becomes `unknown`.

20. **Cancel before launch.** (3.4) The guide has no rule for a cancel that
    arrives while the launch is uncertain. The model asks the helper to take
    the claim file with an exit status "cancelled". A late shim then finds
    the claim and runs nothing. A `prepared` operation is cancelled in the
    cell alone, because the guest never saw it.

21. **Retention.** (3.4) "Floor of 7 days and a ceiling the operator sets."
    The model never drops unacknowledged output when no ceiling is set. A
    ceiling below the floor is raised to the floor. Ack drops the output at
    once. Tombstones of older incarnations are removed only by an explicit
    call, and only when acknowledged.

22. **Run counter.** (7.3 note) The counter that decides "one run" lives in
    the simulated guest, outside the simulated disk. A restore of the disk
    does not roll it back.

## What the model does not express

- D14 and D15 (guest helper crash inside the launch steps, systemd start
  order) need a real helper and a real systemd. The guest in the model runs
  the four steps in one atomic step. `reconcileLaunch` is used for every
  answer, so the table itself is exercised.
- D16 is covered in the form "cell crashes while an operation is
  dispatching" (`lifecycle.test.ts`). The real test kills a node.
- Fault tests D1, D3, D6 to D9, D12 are not about the executor. They are not
  part of this model.
