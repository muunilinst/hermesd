# guest-helper notes

Prototype of the guest launch boundary (porting guide rev 5.1, section 3.4)
in TypeScript on Node. The production helper belongs in the Rust crate
`crates/vm-guest` of muunilinst/caas, with transient systemd units.

Status: specified, not demonstrated. The tests here use the backend
`guest-process` (real helper process, real shim, real files, a process group
as unit). It is not in `DEMONSTRATING_BACKENDS`. Only a real executor, a real
helper and a real TeenyTiny VM count.

## Layout on the workspace disk

```
<workspace>/.hermesd-guest/journal.log     append-only JSON lines, seq 1, 2, 3, ...
<workspace>/.hermesd-guest/claims/<op_id>  the claim file (O_CREAT | O_EXCL)
<workspace>/.hermesd-guest/ops/<op_id>/    stdout, stderr, exit.json
```

## Spec ambiguities and the reading chosen

The rule in all cases: choose the reading that runs the command fewer times.

1. **What is "final status"?** The guide says reconcile every entry "that has
   no final status". Final here means `done` or `failed` only. `not_launched`,
   `starting`, `running` and `unknown` are observations. `unknown` is sticky:
   it can change only to `done` or `failed`, when an exit status appears. It
   never goes back to `not_launched`, even if a claim file is later removed.
2. **Is `not_launched` a journal state or only an answer?** It is recorded as
   an `outcome` record, but it does not block `launch`. A later `launch` for the
   same op_id writes a new `launching` record with `attempt + 1` and a new unit
   name (`hermesd-op-<op_id>-<attempt>`). One claim file per op_id (not per
   attempt) is what makes the second attempt safe.
3. **Step 1 "answer from the journal".** For an op_id that is in the journal,
   `launch` does not return a stored answer. It re-reads the evidence and
   answers with the reconciled status (`starting`, `running`, `done`,
   `failed`, `unknown`). Only `not_launched` leads to a new launch. A stored
   answer would be stale: "running" a minute ago may be "done" now. A retry
   with a different `cmd` or `incarnation` gets the journal answer. Checking
   `incarnation` is the executor cell's job (`expired`).
4. **Fresh launch answer.** After step 4 the helper answers `launched`, not
   `running`. At that moment the helper does not know if the shim has claimed.
   Any later `status` gives the reconciled state.
5. **Adoption.** For `starting` or `running` with no `launched` record (crash
   between steps 3 and 4), the helper writes `launched` with the unit it found,
   so the journal and the system agree. If it cannot read the PID and start
   time, it writes nothing; the answer is still correct.
6. **Unit state cannot be read.** The answer is `unknown` and it is not written
   to the journal, because the read may work later. The same holds when the
   claim directory or the exit file cannot be read. A readable but
   contradictory state (claim, no unit, no exit status) is written as `unknown`.
7. **Older boot with a claim and an exit status.** The table puts "exit status
   written" first, so it gives `done`/`failed` for any boot. `reconcileLaunch`
   from `@hermesd/executor-protocol` is used as it is.
8. **"Older boot" compares the boot ID of the latest `launching` record** with
   the current boot ID, not the `launched` record. A crash between steps 2 and 4
   leaves only `launching`.
9. **Liveness.** A unit counts as alive when any unit of the op_id is alive (any
   attempt), because a late shim of attempt 1 can still claim. The process-group
   manager finds units by the unit name and workspace in the shim's argv (like
   a cgroup lookup by name), and also by the journal's PID plus start time.
   A zombie is not alive. PID reuse is covered by the start time (field 22 of
   `/proc/<pid>/stat`) and the boot ID.
10. **Output files.** The shim writes `stdout` and `stderr` while the command
    runs, syncs them, and then writes `exit.json` atomically (temp file,
    sync, rename, directory sync). A reader sees the exit status or not; never
    half of it. A command killed by a signal has `code: null`; the helper
    maps it to a failure (code 128 in the evidence).
11. **Torn last journal line.** A cut-off last line was never synced, so the
    helper never acted on it. It is dropped when the journal is opened. A bad
    line in the middle is corruption and stops the helper.
12. **Journal sequence.** One number per record, also for records written by
    `reconcile`. `handshake` runs reconcile first, then reports the sequence.
    A handshake with nothing to reconcile writes nothing, so the sequence does
    not move.
13. **One helper at a time.** Calls inside one helper are serialised. Two helper
    processes on one journal are not supported (no lock file). On a VM there is
    one helper. A restarted helper must be sure the old one is dead, as in
    the tests (the old one is SIGKILLed).
14. **Cancel.** `cancel(op_id)` stops all units of the op_id. The shim then does
    not write an exit status, so the result is `unknown`. This matches the
    guide ("a command that was still running ended ... unknown unless its exit
    status was written"). No `cancelled` helper status exists in the table.

## Test-only hooks

| Hook | Where | Use |
| --- | --- | --- |
| `HERMESD_TEST_FAULT` | helper CLI | SIGKILL the helper at `after_launching_write`, `after_unit_start`, `after_launched_write` |
| `HERMESD_TEST_SHIM_HOLD_FILE` | shim | wait for the file before the claim; writes `<file>.reached` |
| `HERMESD_TEST_QUEUE_HOLD_FILE` | process-group manager | delay the shim start, invisible to liveness (models a systemd job in the queue) |
| `HERMESD_TEST_BOOT_ID` | helper CLI | replace the boot ID source (older boot) |
| `HERMESD_TEST_UNIT_UNREADABLE` | helper CLI | unit state cannot be read |

None of these is read in the library code path of a production helper; the CLI
and the shim read them. Remove them (or put them behind a build flag) in the
Rust port.

## What changes in caas vm-guest with systemd

- **Unit manager.** `SystemdUnitManager` is written but not run here: systemd
  is not PID 1 in this container (`/proc/1/comm` is `process_api`). Only its
  pure parts are tested (PID 1 detection, `systemd-run` arguments, parsing of
  `systemctl` output). Check on a real VM: `systemd-run --unit=... --collect`
  exit codes and messages for a name that is already loaded; the output
  columns of `systemctl list-units`; and `MainPID` of a unit that has not
  started yet (the code treats 0 as no PID).
- **Replace `systemctl` calls** with D-Bus (`StartTransientUnit`,
  `GetUnit`/`ActiveState`) or `zbus`. Process spawn per query is slow.
- **Service type.** A service is used, not `--scope`, because a scope runs in
  the foreground of `systemd-run`. `KillMode=control-group` kills the cgroup
  (the command and its children) when the unit stops. A process-group kill
  misses children that call `setsid`; the cgroup does not.
- **Queued start jobs.** In systemd a start job can wait in the queue and run
  after a second launch. The claim file handles it. The test hook for it
  (`QUEUE_HOLD_FILE`) is a model; test the real thing with a stopped unit
  that waits on a dependency (D14 c, "delay an earlier unit start in systemd").
- **Liveness of a finished unit.** `--collect` removes the unit when it ends,
  also when it failed. "Not listed" then means "not alive". Without
  `--collect` a failed unit stays loaded and needs `ActiveState` to be read.
- **Boot ID** comes from `/proc/sys/kernel/random/boot_id`. After a VM boot all
  units of the old boot are gone, so the "older boot" rows of the table are
  exact. Keep the override only in tests.
- **Shim.** Port `shim.ts` to a small Rust binary (`caas-shim`). It must use
  only `openat(O_CREAT|O_EXCL)`, `fsync` on file and directory, and
  `fork/exec`. No async runtime before the claim.
- **Disk.** The workspace disk must honour `fsync` of files and directories
  (ext4 does). If the VM block device caches writes without a flush, the claim
  and the journal are not durable; check the TeenyTiny disk flush setting.
- **Journal format.** JSON lines are enough. Add a CRC per record if the disk
  can tear a sector inside a record.
- **File lock** on the journal (`flock`) to enforce one helper at a time.
