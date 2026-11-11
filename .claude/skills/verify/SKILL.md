---
name: verify
description: Drive hermesd (the TypeScript port of the Hermes agent onto TeenyTiny, Durable Objects and Rivet) and capture evidence that a change works. hermesd has no server and no UI; its surface is test suites and three CLIs. Use this after any change under packages/ or contracts/, when asked to "verify", "prove it works" or "run the port", and to find which subsystem skill (verify-contracts, verify-hosts, verify-executor, verify-loop, verify-plugins, verify-golden, verify-faults, verify-state-port) covers a change.
---

# Verify hermesd

hermesd is a library plus three command-line tools. Nothing listens on a port. To verify a
change you run one subsystem through `verify.ts`, which runs that subsystem's tests and then
types the real commands a person would type, checks what they left on disk, and writes the
evidence to a directory that outlives the run.

One skill per subsystem. This skill holds what they share: launch, doctor, evidence, cleanup.

| Subsystem | Skill | Guide | Packages |
| --- | --- | --- | --- |
| `contracts` | [verify-contracts](../verify-contracts/SKILL.md) | 7.1, 2.4 | `contracts/`, `packages/contracts` |
| `hosts` | [verify-hosts](../verify-hosts/SKILL.md) | 4.6, 6.8 | `host`, `host-node`, `host-cloudflare`, `host-rivet`, `runtime` |
| `executor` | [verify-executor](../verify-executor/SKILL.md) | 3.4 | `executor-protocol`, `executor-model`, `guest-helper` |
| `loop` | [verify-loop](../verify-loop/SKILL.md) | 6.3, 6.4 | `session-actor`, `prompt`, `providers`, `profile-actor` |
| `plugins` | [verify-plugins](../verify-plugins/SKILL.md) | 6.6, 3.5 | `plugin-host` |
| `golden` | [verify-golden](../verify-golden/SKILL.md) | 7.2 | `golden` |
| `faults` | [verify-faults](../verify-faults/SKILL.md) | 7.3, 7.4 | `faults` |
| `state-port` | [verify-state-port](../verify-state-port/SKILL.md) | 6.4 | `state-port` |

"Guide" is the porting guide, rev 5.1. Its decisions are in [docs/adr](../../../docs/adr/README.md).
[features/README.md](features/README.md) maps one turn of the agent onto these subsystems; use
it to pick the subsystems a change touches. A change to `session-actor/src/loop.ts` is not
proved by `loop` alone: the map lists `golden` and `faults` too.

## Launch

There is no process to start. Install once, then each `run` is its own short process.

```sh
bun install        # CI runs: bun install --frozen-lockfile
```

The repository runs on bun only: `bun.lock` is the lockfile, `.bun-version` pins the version, and
`bun run check` (typecheck plus `bun test`) is what CI runs. Each package gets its own
`node_modules` with only what its `package.json` declares, so an undeclared import fails.

Run every command from the repository root.

## Doctor

```sh
bun .claude/skills/verify/verify.ts doctor
```

Read-only. It prints one line per check and exits 1 if any line says `FAIL`: bun and node
versions (node needs 22.18 or later), the workspace links in `node_modules`, miniflare and
rivetkit, `node:sqlite` with FTS5, the upstream pin, the platform, and the git state. Run it
first when a result surprises you.

## Drive

```sh
bun .claude/skills/verify/verify.ts list                       # the 8 subsystems
bun .claude/skills/verify/verify.ts run <subsystem>            # tests, then the real commands
bun .claude/skills/verify/verify.ts run <subsystem> --rt node  # the same on node
bun .claude/skills/verify/verify.ts run <subsystem> --linux    # the same in the pinned oven/bun container
bun .claude/skills/verify/verify.ts run all
```

`run` prints one `PASS` or `FAIL` line, each failed test by name, each skipped file with the
reason, and the path of the evidence. The exit code is 0 only when every test and every drive
passed and at least one test ran.

Which runtime:

- **bun** is the default and what CI runs. It runs the `.ts` files directly and supports
  `node:test` and `node:sqlite`.
- **`--rt node`** is optional, a second opinion. Every subsystem passed on node too when the
  repository moved to bun, and node has caught SQLite differences that bun did not. It is not
  maintained as a target.
- **`--linux`** copies the tree into an `oven/bun` container at the pinned version (without
  `.git`; the evidence names the host's commit, dirty flag and a hash of the uncommitted changes,
  taken before the copy), runs `bun install --frozen-lockfile` and the same `run`, and copies the evidence
  back. This is CI's platform. The guest helper needs Linux (`/proc`, a kernel boot ID). On macOS
  `run` skips those files and says so; `--linux` is how you run them. It needs Docker and the
  network.

`bun test` runs every test file in one process. A test file that calls `process.exit` ends the
whole run with that code, before later files run and without a summary. Never exit from a test;
`rivetkit.test.ts` keeps its exit timer for node only for this reason. A `bun run check` that
prints no `Ran N tests across M files` line did not finish, whatever its exit code.

The proof standard: drive the command a person would type (`packages/golden/src/cli.ts`,
`packages/state-port/src/cli.ts`, `packages/guest-helper/src/cli.ts`), not an internal
function. Check the side effect, not the exit code alone: the helper already checks that
`golden check` left `packages/golden/transcripts` as it found them (by content, before and
after the drive, so a run after `record` passes), that the exported `state.db` exists, and that
a command launched twice ran once. Validate every answer, a retry's too, not just the last one.
Count side effects only after the result has settled, from records the command appends itself.
When you add a drive, add its check: `unchanged` for paths it must not touch, `retry` for a
result that takes time.

## Evidence

Each run writes `.verify/evidence/<UTC stamp>-<subsystem>-<runtime>/`:

- `summary.json`: result, runtime and version, platform, the git commit, whether the tree was
  dirty and (if so) `diffSha`, a hash of the uncommitted changes, test counts, failed test names,
  each drive with its exit code, and what was skipped.
- `tests.log`: the full test output, with the command on the first line.
- `drive-<name>.log`: the output of each real command, with the command on the first line.

`summary.json` always says `"demonstrated": false`. A pass on this machine shows that the code
and its tests agree. It never moves a row of [STATUS.md](../../../STATUS.md) to Demonstrated;
only a fault test on a real host with a real executor, guest helper and VM does that.

Quote the `PASS` line and the evidence path when you report. If files were skipped, say so.

## Cleanup

```sh
bun .claude/skills/verify/verify.ts clean
```

Removes `.verify/tmp`. Each `run` already removes its own scratch directory when it ends, so
`clean` matters only after a killed run. It never touches `.verify/evidence`. Both directories
are in `.gitignore`. Nothing here starts a long-lived process; the tests start and stop workerd
and rivetkit themselves, so there is nothing to kill.

Two runs can go side by side: each has its own stamped evidence and scratch directories, and
the tests use in-memory databases and their own temporary directories.

## Helpers

[verify.ts](verify.ts) is the only helper. It is executable (`./.claude/skills/verify/verify.ts doctor`)
and has no dependencies. The table at its top (`SUBSYSTEMS`) lists, for each subsystem, the
test directories and the drives with their checks. Add a package or a command there.

## Keep it honest

Run `/maintain-verification-skill` when packages, commands or test layouts change.
