# Upstream recovery behaviour, read from source

**This was not executed.** Every statement below comes from reading the Python source of hermes-agent at commit `a9ff9799e273f525b82718cdc69fdec71b1dca5a` (see `upstream/pin.json`). No upstream code was imported or run, and no upstream test was run. Treat each claim as "the code says"; the behaviour tests D1 and D9 (porting guide section 7.1) must confirm it against a running Hermes before the port relies on it.

Paths are relative to the upstream repo root. `file:function` means the named function in that file.

## 1. `hermes sessions recover`

Entry: `hermes_cli/sessions_cmd.py:_cmd_recover`. It needs `--source` and either `--output` or `--inspect-only`. It refuses to overwrite an existing report file. It never touches the active database.

What it does, in order (`hermes_cli/session_recovery.py:recover_session_database`, then `_recover_session_database_output`):

1. Checks the paths and the free disk space (`_validate_paths`, `_disk_space_preflight`).
2. Copies the source and its `-wal`, `-shm` and `-journal` sidecars to a work directory before SQLite opens anything (`_snapshot_and_inspect`, `_copy_source_bundle`). The source is never opened.
3. Inspects the copy. If the required tables are not readable and `--allow-partial` is not set, it stops with `SessionRecoverySourceError`. With `--allow-partial` and no readable `sessions` or `messages`, it falls back to a page-level lost-and-found salvage (`_recover_via_lost_and_found`).
4. Creates a fresh current-schema database at `--output` through `SessionDB` (`_fresh_destination`). The output must not exist and is never swapped into place. If the output is named `state.db`, it first takes an exclusive maintenance reservation (`gateway.runtime_ownership.exclusive_maintenance`).
5. Copies rows table by table (`_copy_table`; row-range salvage when `--allow-partial`).
   - Copied: `system_prompts`, `sessions`, `messages`, `session_model_usage`, `compression_locks`, `gateway_routing`, `async_delegations` (`_CANONICAL_TABLES`), `state_meta` (minus generated FTS and topic markers, `_GENERATED_META_KEYS`), the two Telegram topic tables if present, and `delivery_obligations` (`_AUXILIARY_TABLE_SCHEMAS`, which creates the lazy table in the output first).
   - Rebuilt, not copied: the FTS indexes and the migration bookkeeping (module docstring; `_finalize_derived_metadata`).
   - Excluded on purpose: `runtime_epoch`, `session_admissions`, `worker_executions`, `worker_receipts` (`_RUNTIME_TABLES`). The comment above that constant gives the reason: a partial ledger "could replay already-started effects or adopt workers from another owner". The report states the policy as "transcript-only; runtime ledger excluded; fresh epoch on activation" (`_recovery_report`).
   - Not in any copy list, so not carried over: `conversation_generations`, `gateway_hygiene_state`, `gateway_heartbeats`, `session_turn_leases`. Of these only `conversation_generations` carries lasting meaning (the guide says it is never collected). See finding F2.
6. With `--allow-partial` it also removes orphan rows left by skipped ranges (`_cleanup_partial_orphans`) and can rebuild missing session rows (`_reconstruct_missing_sessions`).
7. Verifies structure, FTS and row counts of the output (`_verify_recovered_database`) and writes a JSON report that does not overwrite (`write_recovery_report`).

Result: a separate transcript database with no ledger. When the owner later activates it, a fresh runtime epoch is created (`hermes_state_runtime.py:begin_runtime_epoch`, which inserts epoch 1 when no row exists).

## 2. Full backup restore

Entry points: `hermes import` and `/snapshot restore`, both through `hermes_cli/backup_restore.py:_import_db_member` and `_import_db_member_exclusive`, which call `_safe_restore_db`. (Backup creation is in `hermes_cli/backup.py`; not read for this note.)

What `_safe_restore_db` does:

1. Runs an SQLite integrity check on the snapshot (`hermes_cli.backup.verify_sqlite_integrity`). On failure it returns `False` and leaves the destination untouched.
2. Takes the exclusive maintenance reservation on the destination directory. If the runtime owns the profile (`OwnershipConflict`), it returns `False`.
3. Stages an epoch floor (`_restore_epoch_source`). If the live `state.db` has a higher `runtime_epoch.epoch` than the snapshot, it copies the snapshot and writes the live epoch into `runtime_epoch` with instance id `offline-restore`, so an older epoch is never reused. If the live epoch cannot be read, it refuses (`_restore_destination_epoch`) and points the user to `hermes sessions recover`.
4. Writes the pages of the (possibly staged) snapshot into the live file with SQLite's backup API, keeping the inode (`_restore_db_pages`). This replaces the whole database, including all four ledger tables.

The docstring of `_restore_epoch_source` states the rule: "Full restores retain all admissions/worker receipts; normal startup advances this floor and reconciles started work to unknown, not replayable queued work."

So a full restore keeps the ledger as it was in the backup. Nothing is reconciled at restore time. Reconciliation happens at the next owner start, described in section 3.

## 3. Owner loss with a started input

"Owner loss" here means a gateway process stopped or restarted while an input was `started`. The code does not detect the loss at the moment it happens. It detects it at the next owner start by comparing epochs.

At start (`gateway/session_authority.py:initialize_session_authority`, called after exclusive profile ownership and before adapters connect):

1. `hermes_state_runtime.py:begin_runtime_epoch` increments `runtime_epoch.epoch` (or inserts 1) and stores the new instance id. The caller must hold the profile ownership lock.
2. `hermes_state_runtime.py:recover_session_inputs(db, epoch=epoch)` runs in one write transaction:
   - child workers (`kind='child'`, not terminal, older epoch) become `terminal` (`hermes_state_runtime_workers.py:retire_stale_children`);
   - workers with status `registered` or `running` and an older `owner_epoch` become `unknown`;
   - a steered input (`terminal` with outcome `steering`) of an older epoch gets outcome `interrupted`;
   - every `session_admissions` row with status `started` and an older `owner_epoch` becomes `unknown`. The function returns that count and its docstring says "Never replay started work. Live worker adoption is a separate explicit operation."
3. `gateway/session_unattended_unknown.py:settle_recovered_unattended` then settles `unknown` rows that nobody can answer (automation, webhook delivery, kanban card) as `terminal` with outcome `interrupted`, through `resolve_unknown_session_input`.
4. Other start-up steps (`backfill_legacy_session_owners`, `backfill_compression_created_sources`, `gateway/session_local_recovery.py:release_handed_off_receipts`) are not part of the ledger rule and were not studied here.

What stays queued behind an `unknown` input: `hermes_state_runtime.py:claim_session_input` looks for `started` or `unknown` rows of the same session. If any is `unknown`, or any worker of the session is `unknown`, it raises `RuntimeStoreError('unknown_execution')` and claims nothing. If a row is merely `started`, it returns `None` (wait). Otherwise it claims the lowest `seq` queued row and sets `started`, `owner_epoch`, and a new `generation`. So later inputs wait until the `unknown` one is resolved, as the guide says.

How an `unknown` input is resolved: `hermes_state_runtime.py:resolve_unknown_session_input`. This is an explicit operator act (`gateway/session_authority.py:resolve_unknown`, `resolve_unknown_as_owner`; `gateway/session_controls.py:resolve_unknown`). It checks the epoch and the `generation`, runs an optional same-transaction closing write for the lost turn's transcript, retires the admission's workers, and sets the row to `terminal` with outcome `interrupted`. It never requeues. If the owner captured the finished result before its settlement write failed, and the row carries the same owner epoch, the captured outcome (`completed`, `interrupted` or `failed`) is stored instead.

A `queued` input is not touched by owner loss; it stays `queued` and keeps its `seq` place.

## 4. Findings that matter for the port

- F1. The recovery rule in guide section 2.4 matches the code: four ledger tables excluded from `sessions recover`, kept by full restore, fenced to `unknown` at the next start (`_RUNTIME_TABLES` in `session_recovery.py`; `recover_session_inputs` in `hermes_state_runtime.py`).
- F2. `sessions recover` does not copy `conversation_generations`. The guide marks that table "never collected" and "preserve". The port's partial export should carry it even though upstream recovery does not; a loss resets the peer's generation counter (see the long comment above its DDL in `hermes_state_common.py`).
- F3. `compression_locks` is copied by `sessions recover` (it is in `_CANONICAL_TABLES`), while guide section 2.4 says it is "written as expired on export". Both are harmless, but a port export that writes it expired differs from upstream recovery output.
- F4. The data-loss ordering is epoch-based, not time-based: nothing in the ledger records "owner died". A restore that lowers the epoch is prevented only by the epoch floor in `_restore_epoch_source`. The port's import must keep an equivalent floor, or `Host.epoch()` must be checked on import.
- F5. Resolving an `unknown` input needs the exact `generation`; a stale generation raises `stale_generation`. The port's resolve call must carry it.
- F6. The guide's deliberate extension (resume an input whose next step is recorded) has no counterpart upstream. Upstream marks every `started` row `unknown`, with no step record.

## 5. Not covered

- `hermes_cli/backup.py` (backup creation) and `hermes_state_portability.py` (export/import of sessions) were not read.
- Cron, kanban and hosted-room recovery paths (`gateway/session_cron.py`, `hermes_cli/kanban_owner_recovery.py`, `gateway/hosted_rooms*.py`) were not read. Hosted-room tables live in a separate `shared-state.db` by default (`gateway/hosted_rooms.py:default_db_path`).
- Worker adoption ("Live worker adoption is a separate explicit operation") was not followed.
