# State port notes

Guide milestone: porting rule 2 (section 6.4), the migration test.
This package moves rows between an upstream-shaped `state.db` (schema
version 32) and the port's actors. Upstream Hermes was not run. Every upstream
fact here comes from `contracts/upstream/*.json` and
`contracts/upstream-recovery.md`.

## What is here

| Part | File |
| --- | --- |
| Upstream DDL (tables, indexes), FTS regeneration | `src/schema.ts` |
| The common shape of both directions (`StateImage`) | `src/image.ts` |
| Import: `state.db` file to image | `src/read-db.ts` |
| Image to the actors | `src/apply.ts` |
| Actors to image | `src/read-actors.ts` |
| Export: image to a fresh `state.db` | `src/write-db.ts` |
| Test sample, command line | `src/sample.ts`, `src/cli.ts` |
| Test of the rules, no platform | `src/state-port.test.ts` |
| The migration test on the Node simulator | `src/migration.test.ts` |
| The last step, by hand | `../../contracts/resume-check.sh` |

## Owners on import (guide 6.4)

- Profile actor: `conversation_generations`, `state_meta`, `schema_version`.
  The list of sessions, the actors to reconcile with, and the search documents
  are derived from the session rows. Call `rebuild_index` on the profile actor
  after an import. The FTS index is made again from the documents.
- Session actor: one for each chain of sessions joined by `parent_session_id`.
  It is keyed by the first session of the chain. It holds `system_prompts`,
  `sessions`, `messages`, `session_model_usage`, and the ledger rows of its
  sessions. `sa_meta.current_session` is the newest leaf of the chain.
- Rows are written with the ids they have in the file. An import fills empty
  actors. It does not merge.

## Rules and where we chose

1. **A started input becomes unknown on import.** Upstream marks a `started`
   admission `unknown` at the next owner start and never replays it
   (`upstream-recovery.md`, section 3). An import is an owner start, and the
   runtime holds the inbox while any admission is `started` or `unknown`. So
   `readStateDb` does the same. The owner epoch and generation stay.
2. **Full or partial.** `ledger: "keep"` on import and `mode: "full"` on export
   keep `runtime_epoch`, `session_admissions`, `worker_executions` and
   `worker_receipts`. The other value leaves the four tables out, as
   `hermes sessions recover` does.
3. **In-flight turn.** In a full export, the admission of a turn that is still
   open is written as it is in the runtime table: `started`, with the owner
   epoch of the actor and a generation. Upstream marks it `unknown` at its next
   start. This is the one place where the port differs from upstream on purpose
   (guide 6.3: the port resumes a turn, upstream does not). A partial export has
   no admissions, so the turn is not in that file. The pending rows, the wake
   obligations and the loop position are not exported. Upstream has no place
   for them.
4. **Leases and locks are written as expired, never live.** The port has no
   lease table; actor ownership and `Host.epoch()` replace it. An open turn
   gives one `session_turn_leases` row. A compaction that has started and not
   finished gives one `compression_locks` row. Both have `expires_at` one
   second before the time of the export. Rows of these tables in a source file
   are not imported.
   - Upstream's `sessions recover` copies `compression_locks` as it finds
     them (finding F3). Our partial export writes the expired row too, so it
     differs from upstream's output only by that row. We kept the guide's rule.
   - `session_turn_leases` is not in upstream's copy list. We write it in both
     modes. It is expired, so it should do no harm. Not checked against a
     running Hermes.
   - `acquired_at` of a lock is set to the same instant as `expires_at`,
     because `compaction_link` has no time.
5. **`conversation_generations` is carried in a partial export** although
   upstream's recovery drops it (finding F2). The guide says the table is never
   collected. A loss would reissue a retired scope.
6. **Epoch floor.** A full export writes `runtime_epoch.epoch` as the highest of:
   the owner epochs of all actors, the `owner_epoch` of every admission and
   worker row, the `runtime_epoch` of the file that was imported (stored as
   `profile_meta.upstream_runtime_epoch`), and 1. This is the idea of
   `_restore_epoch_source`: an older epoch is never used again. The instance id
   is `hermesd-port-export`. A host adapter should raise its actors' epochs to
   at least `epochFloor(image)` on import. The Node simulator test does this by
   hand. `Host.epoch()` belongs to the platform, so `applyProfileImage` does not
   set it.
7. **FTS is regenerated.** The two FTS5 tables are created with the plain layout
   from `hermes_state_common.py` (lines 1159 and 1188) and filled from
   `messages`. `state_meta` keys that match `fts` or `trigram` are dropped on
   import. Upstream drops its generated markers on recovery too
   (`_GENERATED_META_KEYS`), but we do not have that list. The regex is our
   guess.
8. **Ids that two actors share.** Each session actor numbers `messages.id` and
   `session_admissions.seq` on its own. An export keeps the ids of the first
   actor and, if a later actor uses a taken id, gives all rows of that actor new
   ids above everything used, in the old order. `ExportReport.renumbered` lists
   them. Message ids are not used elsewhere in the upstream tables we write
   (links use `message_uid`). Comparing images ignores these ids
   (`canonicalImage`).
9. **A queued admission without a session row.** Upstream has a foreign key from
   `target_session_id` to `sessions(id)`. The runtime table has no such key, and
   the session row is made at the first turn. The export makes a bare session
   row (`source = 'teenytiny'`) when it is missing. It is listed in
   `stubSessions`.
10. **A prompt that no session uses** stays with the first actor.
11. **No overwrite.** The export refuses to write over a file, as upstream's
    recovery does. If it fails, it deletes the file it made.

## Not carried, with the reason

Counted in `ImportReport.dropped`, and not written back:

- `session_turn_leases`, `compression_locks`: replaced (rule 4).
- `async_delegations`, `delivery_obligations`: the guide says preserve, in the
  session actor. The port has no table for them yet. Their owner is the delegation
  and gateway code, which does not exist here.
- `gateway_routing`, `gateway_hygiene_state`: gateway router.
- `gateway_heartbeats`: not supported in the actor (guide 2.4).
- The two Telegram topic tables: provisional, not supported.

A real `state.db` with rows in these tables loses them in a round trip through
the port. Do not use an exported file to replace a live one without checking
this list. `worker_executions` and `worker_receipts` are kept as plain rows in
the session actor (upstream DDL, no code uses them yet).

## What the schema check proves, and what it does not

The migration test compares `sqlite_master` of the exported file with a database
made from `contracts/upstream/state-schema.json` (tables and indexes, text equal),
and the table text with the contract file after white space is normalised.

Limits:

- The contract file has the `CREATE TABLE` text, but not the text of indexes or
  triggers. Our `CREATE INDEX` statements are built from the columns and the
  WHERE text. The index `idx_session_admissions_cron_request` has a placeholder
  (`{CRON_PRINCIPAL_ID}`) in its WHERE text and is left out.
- **No triggers are written.** The contract file lists 17 trigger definitions on `messages` (display
  order, message uid, FTS) and a delete guard on `sessions`. Upstream should
  create them when it opens the file. Not verified. Because the trigger for
  `display_order` does not run on our inserts, `display_order` is NULL in the
  exported messages; the index `idx_messages_display_backfill` suggests that
  upstream backfills it.
- The FTS layout may not be the one that upstream's migration expects
  (`fts_storage_version: 3` uses a `messages_fts_src` table). The file has no
  `fts_storage_version` marker, so upstream should rebuild. Not verified.
- `PRAGMA user_version` and other pragmas are not set.
- Only the last step (`hermes chat --resume`) tells us if these gaps matter.
  Run `contracts/resume-check.sh`.

## Changes outside this package

- `packages/runtime`: `session_admissions` is now upstream's table (see its
  NOTES.md). A new side table `rt_admission_port` holds the turn id, the result
  text, the epoch at receipt and times.
- `packages/session-actor`: the optional `session_search` tool (see its NOTES.md);
  `worker_executions` and `worker_receipts` DDL; `setCurrentSessionId` is exported;
  a message row without `message_uid` gets `row-<id>` when it is read.
- `packages/profile-actor`: `applyProfileSchema` is exported (it was inline in
  `activate`); the profile also creates `state_meta` and `schema_version`.

## Open points

- The step `hermes chat --resume` (skipped test, `contracts/resume-check.sh`).
- The tables in "Not carried".
- Triggers and the FTS layout (above).
- The simulator test runs on the two Node modes only. It does not run on a
  real host.
- A real, large `state.db` was not tried. Import reads all rows into memory.
