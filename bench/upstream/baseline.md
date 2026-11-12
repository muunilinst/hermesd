# Upstream Hermes baseline

> **Note: the driver scripts were fixed after the run, statically.** After PR review the scripts in `work/` (`bench.py`, `record.py`, `persist_fail.py`, `batch.sh`, `bench-all.sh`) were changed without being re-run (upstream Hermes was not available where the fixes were made). No measured number in this file or in `baseline.json` was changed. The fixes: the kill -9 experiments now kill only after the intended trigger is observed and mark the sample invalid otherwise; the clean pass validates each reply (scripted text, no error envelope, expected request count) before timing it; WAL deltas are taken only within one WAL generation (header salts); the recorder pins Bedrock to the local scripted server and applies the documented provider settings; scripts stop on a failed step; the two persistence-failure variants are kept under separate names; port clean-up no longer kills by port or process name.
>
> Numbers that need a re-run on the Mac before they are trusted: the **kill -9 samples** (the old driver killed after a 60 s wait even if the trigger never occurred), the **clean-pass latency** (`clean_wall_s`, median and p95; the old pass did not check replies, and the checked-in `turns-tool.run1-steps-exhausted.json` shows what an unvalidated sample looked like), and the **WAL deltas** (`wal_frames`, `wal_commit_frames`; the old code subtracted counts across WAL resets). The recorded transcripts were produced by the old `record.py`; the Bedrock and named-provider ones should be re-recorded to confirm they match.

The raw numbers are in `baseline.json`, and each run's output is in `work/results/*.json`. The drivers are `work/bench.py` and `work/bench-all.sh`, run inside the VM from the worktree root.

## Where it ran

- OrbStack Linux machine `hermes-base`: Ubuntu 26.04.1, kernel 7.0.14-orbstack, aarch64, 10 vCPU, 8,998 MiB RAM. The host is an Apple M3 Pro (11 cores, 18 GiB), macOS 27.0. The VM shares its CPUs with the host. OrbStack hung once during the run and was restarted; every number below comes from runs after the restart, except cold start, which came before it.
- Hermes `a9ff9799` (reports 0.23.0), installed from a source checkout with `uv sync --frozen --extra anthropic --extra bedrock --extra messaging` on CPython 3.14.10 (SQLite 3.53.1). `state.db` is in WAL mode with a page size of 4096.
- Long-lived mode: `hermes gateway run` in the foreground with the API server platform (`API_SERVER_ENABLED=true`, `API_SERVER_KEY`, port 8642, set in `$HERMES_HOME/.env`). A turn is a non-streaming `POST /v1/chat/completions`. `X-Hermes-Session-Id` continues the session.
- Config: a custom provider at the scripted server, `streaming: false`, title generation off, `_config_version: 52`.
- Model: `packages/golden/scripted-server/server.mjs` under bun 1.4.2 on 127.0.0.1:8090. It answers at once, so the times below are Hermes time.

## Cold start (5 runs each)

Measured from launching `hermes gateway run` until `GET /health` answers, and until the first chat completion returns the scripted reply.

| | median to /health | median to first reply | runs (health / first reply, s) |
| --- | --- | --- | --- |
| reused `HERMES_HOME` (run 0 was a fresh home) | 2.91 s | 3.82 s | 5.16/6.48, 3.31/4.09, 2.88/3.74, 2.77/3.55, 2.91/3.82 |
| fresh `HERMES_HOME` each run | 3.24 s | 4.40 s | 3.24/4.56, 3.25/4.30, 3.27/4.40, 3.21/4.39, 3.17/4.42 |

## Memory (VmRSS summed over the gateway process tree)

| when | KiB | MiB |
| --- | --- | --- |
| right after start and first reply (10 runs) | 250,904 to 259,028 | 245 to 253 |
| plain: after start and warm-up turn | 252,000 | 246 |
| plain: after 40 turns (20 with strace, 20 without) | 294,156 | 287 |
| tool: after start and warm-up turn | 286,280 | 280 |
| tool: after 40 turns | 309,724 | 302 |
| idle run: 5 s after one turn | 281,460 | 275 |
| idle run: after 5 min idle | 260,884 | 255 |

RSS falls while idle because the gateway's housekeeping calls `malloc_trim` (logged as `hermes_cli.mem_trim`).

## Turn overhead (20 turns each, no strace attached)

Measured as the wall time from sending the request to receiving the reply. One warm-up turn came first and is not counted.

| script | median | p95 | with strace attached (median) |
| --- | --- | --- | --- |
| `plain-reply` (1 model request) | 96 ms | 154 ms | 213 ms |
| `one-tool-call` (2 model requests and a real `echo hello`) | 156 ms | 215 ms | 352 ms |

The raw values are in `baseline.json`. An earlier tool run is set aside in `work/results/turns-tool.run1-steps-exhausted.json`: its last two turns ran out of scripted steps and spent 300 s in Hermes's retry backoff.

## Writes per turn

The figures below are typical turns.

| | plain-reply | one-tool-call |
| --- | --- | --- |
| `messages` rows | +2 | +4 |
| `session_admissions` rows | +1 | +1 |
| `state_meta` rows | +1 | +1 |
| FTS rows (`messages_fts*`, `messages_fts_trigram*`) | +2 in each of 10 tables | +3 or +4 in each |
| WAL commit frames | 14 to 15 | 19 to 20 |
| fsync on `state.db-wal` | median 14 (14 to 16) | median 20 (19 to 22) |
| write syscalls on `state.db-wal` | median 152 | median 248 |

- Row counts were taken from every `state.db` table, read-only, before and after each turn. They show inserts only, so in-place updates (the admission status changing, session counters) are not counted.
- WAL commit frames were counted from the `state.db-wal` file, using only frames with the current salt. A turn in which a checkpoint reset the WAL has no count; that happened in about one turn in three.
- The fsync and write counts come from `strace -f -e pwrite64,write,fsync,fdatasync -yy`. One fsync of the WAL per commit matches the commit-frame count.
- `state.db` itself gets 0 or 1 fsync per turn, from checkpoints. Every few turns `kanban.db` and `cron/executions.db` are also written.
- Occasionally an FTS segment merge shrinks `messages_fts_data`/`_idx` (−11 in one tool turn).

## Idle CPU over 5 minutes

Measured as utime+stime of the gateway process tree from `/proc/<pid>/stat`, over 300.3 s after one turn: **1.72% of one core** (5.16 CPU seconds). It rises steadily, about 1 s every 30 s, from the gateway's 60 s housekeeping and cron ticks.

## Shutdown survival (kill -9 of the gateway, 3 runs each)

The procedure was: kill -9 the gateway, start it again, watch for 75 s, then retry the same request with the same `Idempotency-Key`.

**(a) Model call held.** The kill came about 1 s after the scripted server got the request and held it. The hold was released 3 s after the restart. All 3 runs:

- The client's connection was closed at once (`RemoteDisconnected`). The reply never arrived.
- Rows in `state.db` at the kill were the user message only. Nothing changed after the restart.
- After the restart Hermes sent no new model request: the count stayed at 2 (warm-up plus the held one). The released answer went to a dead socket.
- `session_admissions` for the turn stayed `status = unknown`, `outcome = NULL`.
- The retry with the same Idempotency-Key got **HTTP 409 Conflict**. The work did not run again, and no reply was replayed.
- Verdict: **marked unknown, not replayed, not completed. The reply is lost.**

**(b) `sleep 30` running.** The command was `echo start >> m; sleep 30; echo end >> m`. All 3 runs:

- The client's connection was closed at once. The reply never arrived.
- Rows at the kill were the user message and the assistant tool-call message (`running`). There was no tool result row, and none was added after the restart.
- Right after the kill, Hermes's owner-death supervisor (`hermes_cli/process_supervisor.sh`) and the command's process group were still alive. The supervisor sees EOF on its pipe and SIGTERMs, then SIGKILLs, the registered groups. The marker file held only `start`, and still did 80 s later: the command was **killed partway through and not re-run** (it did not run twice).
- After the restart there was no new model request (2 in all). The admission stayed `unknown`. The retry with the same Idempotency-Key got **HTTP 409 Conflict**.
- Verdict: **marked unknown, the command killed and not replayed, the turn not completed. The reply is lost.**
