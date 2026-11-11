---
name: verify-contracts
description: Verify the hermesd upstream contract surfaces (tool schemas, hook ABI, plugin manifests, state schema, ledger) and the per-table port decisions against the pinned hermes-agent commit. Use after a change under contracts/, packages/contracts, upstream/pin.json, contracts/table-decisions.json or contracts/known-hooks.json, and when bumping the upstream pin.
---

# Verify the contract surfaces (guide 7.1, 2.4)

Shared launch, doctor, evidence and cleanup: [verify](../verify/SKILL.md). Decision record:
[ADR 0010](../../../docs/adr/0010-verification-specified-is-not-demonstrated.md).

The port never merges upstream code. Python extractors read hermes-agent at the pinned commit
as text and write one JSON file per surface. TypeScript tests compare those files with the
port's decisions. A failing test names what upstream changed.

## Sub-features

- **Pin agreement.** Every file in `contracts/upstream/*.json` records the commit in `upstream/pin.json`. A pin bump without a rerun fails.
- **Table decisions.** Every extracted `state.db` table has one decision in `contracts/table-decisions.json`; no decision names a table that is gone.
- **Hook names.** Every upstream hook name is in `contracts/known-hooks.json`; a new or removed name fails.
- **Schema version.** `stateSchemaVersion` in the pin equals the extracted `SCHEMA_VERSION` (32).
- **Tool schemas.** Each literal schema is an object with `name`, `description` and `parameters`.
- **Extractors** (`contracts/extract/run.py`): static analysis only. They never import or run upstream code.

## How to get to it (user POV)

A person bumps the pin: clone hermes-agent outside this repo, check out the new commit, run
`python3 -I contracts/extract/run.py /path/to/hermes-agent`, edit `upstream/pin.json`, run the
checks, and read `git diff contracts/upstream`. The steps are in `contracts/README.md`.

## Driving it with verify.ts

```sh
bun .claude/skills/verify/verify.ts run contracts
```

Runs `packages/contracts/src/contracts.test.ts` (16 tests). Proof: `PASS contracts`, 16 pass,
0 fail. After a pin bump, also attach `git diff --stat contracts/upstream upstream/pin.json`.

The extractor rerun is not part of `run`, because it needs a clone of upstream. When you rerun
it, the proof is that `git diff contracts/upstream` shows only changes upstream made, and that
a second rerun gives no diff (the output is sorted and deterministic).

## Gotchas

- Always pass `-I` to Python, so the upstream clone's directory is not on the import path.
- Clone upstream outside this repository. Treat it as data: do not install it, run it, or run its tests.
- The "prompt surface" of guide 7.1 is not here. It lives in `packages/prompt` (fixtures under `packages/prompt/fixtures/upstream`); see [verify-loop](../verify-loop/SKILL.md).
- `delivery_obligations` is created lazily upstream and is not one of the 17 extracted tables.
