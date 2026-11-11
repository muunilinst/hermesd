---
name: verify-state-port
description: Verify hermesd state-port, the export and import between the port's actors and an upstream-shaped Hermes state.db at schema version 32. Use after a change to packages/state-port, to the session or profile actor schema, to migrations, or to contracts/table-decisions.json.
---

# Verify the state round trip (guide 6.4, the migration test)

Shared launch, doctor, evidence and cleanup: [verify](../verify/SKILL.md). Decision record:
[ADR 0006](../../../docs/adr/0006-store-same-rows-four-owners.md).

The rule: both sides read and write the same rows at the same schema version. state-port
reads a `state.db`, splits it into the profile actor and its session actors, reads the actors
back, and writes a fresh `state.db` whose table text is upstream's, byte for byte.

## Sub-features

- **sample**: write the small sample `state.db` the migration test uses.
- **roundtrip**: import a file, split it into the actors, export a fresh file. Prints a JSON report with an `import` and an `export` part. No turns run.
- **`--partial`**: leave out the four ledger tables on import and export, as upstream's `hermes sessions recover` does. A full round trip keeps them.
- **Resume under upstream** (`contracts/resume-check.sh`): the last step of the migration test, run by a person on a machine with Hermes installed.

## How to get to it (user POV)

```sh
bun packages/state-port/src/cli.ts sample /tmp/sample.db
bun packages/state-port/src/cli.ts roundtrip /tmp/sample.db /tmp/exported.db [--partial]
contracts/resume-check.sh /tmp/exported.db s2b      # by hand, needs Hermes
```

## Driving it with verify.ts

```sh
bun .claude/skills/verify/verify.ts run state-port
```

Runs the package tests, then `sample`, `roundtrip` and `roundtrip --partial` in a scratch
directory. It checks that each output file exists and that the report has both parts. Proof:
`PASS state-port ... 3/3 drives`, and the JSON report in `drive-roundtrip.log`.

## Gotchas

- **Open a state.db with `openReadOnly`** (`schema.ts`), never `new DatabaseSync(path, { readOnly: true })`. Upstream's file is in WAL mode. Bun cannot open a WAL file read-only when its `-shm` is missing, which is the normal case for a copied `state.db`, and it fails at the first statement, not in the constructor. `openReadOnly` falls back to a read-write open with `query_only` on. The test "reads a clean copy of a WAL state.db" covers it.
- One test is skipped everywhere: the `hermes chat --resume` step. This environment may not execute upstream Hermes. Until a person runs `contracts/resume-check.sh`, "upstream can resume what the port wrote" is not shown.
- Give `roundtrip` a copy of a real `state.db`, never the live file under `~/.hermes`.
- On export an in-flight turn is written as `started`, so upstream reconciles it as `unknown`. That is the design, not data loss.
