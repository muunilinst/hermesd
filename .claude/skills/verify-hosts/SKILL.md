---
name: verify-hosts
description: Verify the hermesd Host interface and its adapters (the in-memory Node simulator, Cloudflare Durable Objects on local workerd, Rivet Actors on real rivetkit) plus the runtime rules built on it, which are wake obligations, the transactional outbox, the session_admissions inbox and the sweeper. Use after a change to packages/host, host-node, host-cloudflare, host-rivet or runtime.
---

# Verify the hosts and the runtime rules (guide 4.6, 6.8)

Shared launch, doctor, evidence and cleanup: [verify](../verify/SKILL.md). Decision records:
[ADR 0003](../../../docs/adr/0003-one-host-interface-three-platforms.md) and
[ADR 0005](../../../docs/adr/0005-loop-rows-wake-obligations-sweeper.md).

Agent code imports only `Host` (`id`, `epoch`, `tx`, `commit`, `arm`, `fetch`, `sidecar`). Each
adapter must meet the same rules: the epoch rises at every activation, intent and state commit
in one transaction, arm first then commit, re-arm first in the handler, nothing leaves the
actor before commit, and every write carries the epoch.

## Sub-features

- **host-node** (`platform.test.ts`): the simulator with a Durable Objects rule set and a Rivet rule set, a fake clock, and crash and timer fault hooks. The fault tests run on it.
- **host-cloudflare** (`index.test.ts`, `workerd.test.ts`): the Durable Objects adapter, also used for TeenyTiny v2. `workerd.test.ts` starts a real local workerd through miniflare with `test-worker/`.
- **host-rivet** (`index.test.ts`, `rivetkit.test.ts`): the Rivet 3.0 adapter. `rivetkit.test.ts` runs real rivetkit: reload of rows, FTS indexes and `AUTOINCREMENT` marks, `keepAwake`, a schedule whose first run fails.
- **runtime** (`runtime.test.ts`): wake obligations, outbox, inbox, sweeper, independent of any adapter.
- **Actor-side fault tests** (`packages/faults/src/actor`): D3, D6, D8, D9 (eight cases), D12, the inbox crash, and two parallel Rivet actions.

## How to get to it (user POV)

There is no command. A host is reached when a platform activates an actor. The nearest thing
to a user path on this machine is a real workerd and a real rivetkit, which the two
`*kit`/`workerd` test files start and stop themselves.

## Driving it with verify.ts

```sh
bun .claude/skills/verify/verify.ts run hosts
bun .claude/skills/verify/verify.ts run hosts --linux       # the same as CI: bun on Linux
```

Proof: `PASS hosts on bun`, 138 pass, 0 fail in 13 files, on macOS and in the Linux container.
The run takes about 20 s; the rivetkit file waits on real sleep timeouts.

## Gotchas

- **Never write to an FTS shadow table.** Newer runtimes (node 24.21, bun 1.4.2) open SQLite in defensive mode, which refuses it (`table search_fts_content may not be modified`); node 22 did not. `RivetHost.#load` creates each FTS table, then copies every shadow row exactly as stored, with defensive mode off on the mirror for that copy only. It parses no options and rebuilds nothing, so hidden data survives (an FTS4 `languageid`, an FTS5 locale) and contentless tables load too. Do not go back to `SELECT rowid, *` plus `rebuild`: that drops the hidden columns, and option parsing can be fooled by a comment in the `CREATE` text. Tests: "keeps the FTS4 language id", "a comment that looks like a content option", "a contentless FTS5 index".
- **workerd runs JavaScript.** `workerd.test.ts` strips the adapter's types with the TypeScript compiler (`transpileModule`), which works on node and bun. Do not switch it to `stripTypeScriptTypes` from `node:module`: bun does not have it.
- **A turn outside `keepAwake` is cut off by sleep, and the order differs by runtime.** On node the actor's abort signal fires first; on bun rivetkit closes the database first, so the turn's next write throws `Database is closed`. The keepAwake test's control turn treats that error as the expected cut-off. Checking `signal.aborted` before a write is not enough on bun.
- A pass on workerd or rivetkit locally is not "demonstrated". STATUS.md has `durable-objects` and `rivet` columns for deployed hosts; they stay `-`.
- "Immediate code update during a 60 s model call" needs a deployed Worker and cannot run here.
- Whether `setAlarm()` then `sync()` makes an alarm durable before the SQL commit on Cloudflare is assumed, not documented (open question 6).
