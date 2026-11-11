# 0012. Run the repository on bun

- Status: Accepted
- Date: 2026-11-11
- Source: not from the porting guide; a tooling decision of this repository

## Context

The repository ran its tests with `node --test` on node 22, installed with npm, and CI used
`setup-node`. The port does not run on node in production: its targets are workerd (Durable
Objects and TeenyTiny v2) and Rivet (which also supports bun). The test runtime is therefore
a tooling choice. Bun runs the `.ts` files directly, provides `node:test` and `node:sqlite`,
and installs and tests faster.

Moving needed four changes, each a real difference between the runtimes:

- `workerd.test.ts` stripped types with `stripTypeScriptTypes` from `node:module`, which bun lacks. It now uses the TypeScript compiler's `transpileModule`.
- Bun cannot open a WAL-mode SQLite file read-only when its `-shm` is missing, which is how a copied `state.db` arrives. `openReadOnly` (state-port) and `assemble.mjs` fall back to a read-write open with `query_only`.
- On bun, rivetkit closes the actor's database before it fires the abort signal, so a turn cut off by sleep fails its next write. The keepAwake test's control turn treats that as the cut-off.
- `bun test` runs every file in one process. A `process.exit` in one test file ended the whole run with code 0 and no summary, so CI would have passed with 11 files never run. The exit in `rivetkit.test.ts` now runs under node only.

## Decision

- Bun is the only runtime and package manager. `bun.lock` is the lockfile; `package-lock.json` and `.nvmrc` are gone.
- `.bun-version` pins the version (1.4.2). `package.json` names it in `packageManager`. CI uses `oven-sh/setup-bun` with that file, `bun install --frozen-lockfile`, and `bun run check`.
- `bun run check` is `bun --bun tsc -p tsconfig.json` then `bun test --timeout 60000 ./packages`. The timeout replaces bun's 5 s default, which the rivetkit setup exceeds under load.
- Each package declares every workspace package it imports. Bun's isolated install enforces it.
- Tests that need Linux skip on other systems with a reason (`testkit.needsLinux`), so a full run on macOS finishes and reports.
- `@types/node` stays: the code imports `node:*` modules, which bun implements.

## Consequences

- One runtime to keep green. The verify driver keeps `--rt node` as an optional second opinion; node is not a supported target.
- A test file must never call `process.exit`. A run that prints no `Ran N tests across M files` line did not finish, whatever its exit code.
- The dependency-free scripts in `packages/golden/scripted-server` run on bun or on Node 22.18 or later, for a person recording upstream transcripts.
- The fault backend named `node` is the in-memory host simulator (`packages/host-node`), not the node runtime. Its name did not change.

## How we check it

`bun run check` in a clean `oven/bun:1.4.2` container: 61 files, 793 pass, 21 skip, 0 fail. On
macOS: 61 files, 767 pass, 21 skip, 0 fail (the guest tests skip). `verify.ts run all` and
`verify.ts run all --linux` pass every subsystem.
