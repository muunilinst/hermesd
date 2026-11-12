---
name: verify-golden
description: Verify the hermesd golden transcripts. Plays the 20 scripted-model scenarios through the session actor and compares each record (model requests, messages rows, session_admissions rows) with the committed port transcript and, where one exists, the upstream Hermes transcript. Use after any change that can alter what the loop sends to the model or writes to its rows, and after editing packages/golden.
---

# Verify the golden transcripts (guide 7.2)

Shared launch, doctor, evidence and cleanup: [verify](../verify/SKILL.md). Decision record:
[ADR 0010](../../../docs/adr/0010-verification-specified-is-not-demonstrated.md).

A scripted model gives fixed answers. The runner records every request the loop sends, in
order, and the rows the run wrote. A difference from the committed record is a port bug or an
intended change; the diff tells you which.

## Sub-features

- **list**: the 20 script names and purposes (`packages/golden/scripts/*.json`).
- **check**: play scripts on the Node simulator in both rule sets (`durable-objects` and `rivet`) and fail if a committed `transcripts/port/<name>.json` differs.
- **record**: play scripts and overwrite the committed port transcripts.
- **compare**: diff port and upstream transcripts; names the request index and the field. `--ignore <path>` and `--strict` change the ignore list.
- **scripted-server/**: dependency-free Node scripts a person uses to record the upstream side (`packages/golden/UPSTREAM.md`).

## How to get to it (user POV)

```sh
bun packages/golden/src/cli.ts list
bun packages/golden/src/cli.ts check [name...]
bun packages/golden/src/cli.ts record [name...]
bun packages/golden/src/cli.ts compare [name...] [--ignore path] [--strict]   # default: policy vs transcripts/upstream/expected-differences.json; --strict: exact parity
bun packages/golden/src/cli.ts baseline [name...]    # rewrite expected-differences.json
```

`node` works in place of `bun`.

## Driving it with verify.ts

```sh
bun .claude/skills/verify/verify.ts run golden
```

Runs the package tests, then `list` (must print 20 lines), `check` with no names (must print
20 `same` lines, no `DIFFERS`, and leave `packages/golden/transcripts` clean in git), and
`compare`. Proof: `PASS golden ... 3/3 drives`, and `drive-check-all.log` in the evidence.

When you changed the loop on purpose: run `record`, then read `git diff packages/golden/transcripts`
line by line. The diff is the proof; each changed request or row must follow from your change.
Then run `verify.ts run golden` again.

## Gotchas

- `transcripts/upstream/` has no records yet, so `compare` prints `skip <name>: no upstream transcript` for all 20 and exits 0. That is not a comparison. Do not report port and upstream as equal.
- The 20 skipped tests in `run golden` are those upstream comparisons.
- `record` rewrites committed files. Never run it to make `check` pass without reading the diff.
- Timestamps, row ids, message uids, call ids and the idempotency key are left out of a record on purpose; dates written `YYYY-MM-DD` compare equal.
- The port runs commands on a simulated executor. Script commands must be ones whose real output is the same (`echo hello`).
