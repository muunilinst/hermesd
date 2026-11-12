# Session actor notes

Guide milestone 1, step 4 (agent side) and step 5. These notes list the
decisions made and every change to an existing contract.

## Contract changes

1. `PrepareRequest.session` (executor-protocol). `fence(session, epoch)` and
   the per-session minimum epoch need the session of each operation. The model
   (`executor-model`) and its tests are updated. See its NOTES.md.
2. `done.result` is NOT made optional. The loop never needed it.
3. Runtime (`packages/runtime`):
   - The runtime table `messages` is now `rt_messages`. The name `messages` is
     the upstream table and must stay free for it.
   - `TurnContext.step({settle, write, pend, finish})` does several changes in
     one commit. Without it, a tool-call turn and its ops could not be written
     in one commit.
   - `SessionActor.poke()` and `kick()` wake the turn driver from outside
     (stop, answer to a clarify question, adoption).
   - `finish` accepts the outcome `"unknown"`.

## Decisions

- Upstream tables are at schema v32. DDL is generated from
  `contracts/upstream/state-schema.json` by `src/generate-ddl.ts`. A test fails
  if the committed `upstream-ddl.ts` drifts.
- Port tables (`pending_call`, `pending_op`, `loop_turn`, `clarify_question`,
  `todo_item`) carry `schema_version` and a JSON `data` column. Migration is
  forward-only, per version, on first read, and writes the row back. Only v32
  exists, so the mechanism is tested with made-up versions. A row from a newer
  version throws `RowFromFutureError`.
- `op_id = deriveOpId(tenant, session, tool_call_uid)`. The incarnation comes
  from `describe` once per intent and is stored with the op.
- A tool-call turn is persisted before any op row is written. A persistence
  failure before that point runs no tool.
- Unknown rule: when `status` says unknown after `prepare` was recorded, the
  loop re-prepares with the stored incarnation. When the executor cannot say,
  the admission is marked unknown, the user is asked, and later inputs wait.
- `/stop` writes `loop_turn.interrupted`, aborts the fetch, drops partial
  output, and calls `cancel(op_id)` on running ops. A late result is accepted
  and discarded. As upstream (`src/replay.ts`): the admission ends `terminal` with
  outcome `interrupted`; a cut-off command's row gets the executor's interrupt result
  (`[Command interrupted]`, exit 130), a call that had no operation gets a cancelled
  result; the turn is closed by an assistant row, the hidden placeholder
  (`api_content` = `[interrupt: no assistant output for this turn]`) after a tool row or
  the failed-turn notice after the user row. Every request rewrites an interrupted result
  of a side-effecting tool into the orphan-recovery notice that its effect is UNKNOWN,
  and drops an all read-only interrupted block. Differences kept on purpose: a partial
  streamed answer is still dropped (upstream keeps it as a visible row), and an open
  operation counts as cut off even if the executor had not started it.
- clarify writes a question row and ends the turn. The answer is the next
  admission. The wait survives a restart (7.4 upgrade test).
- Tool schemas: clarify and todo are the literal upstream schemas.
  `terminal` is `provisional: true` (upstream file: `tools/terminal_tool.py`).
- The profile search uses FTS5 when SQLite has it, else LIKE.
  `conversation_generations` rows are never collected.
- Profile actor is fed only by the session outbox, with idempotency keys.
  Activation reconciles.

- The runtime's `session_admissions` now has upstream's columns (runtime NOTES,
  item 13). The golden record reads `status` and `outcome` from it.
- `session_search` is an optional tool. It is not in `SUPPORTED_TOOLS`, so the
  default requests do not change. Set `tools: [...SUPPORTED_TOOLS, "session_search"]`
  to turn it on. It uses the upstream schema literal, but only the `query` shape
  works. It asks the profile actor over the sidecar and returns the port's JSON
  (`success`, `query`, `count`, `results` of session, seq, role, text), not
  upstream's hydrated sessions. It only reads, so the planning step may repeat.
- `worker_executions` and `worker_receipts` are created with upstream's DDL. No
  code uses them yet; `packages/state-port` fills them on import.
- A message row with no `message_uid` (an imported row) gets `row-<id>` when read.

- Hook seam: `LoopHooks` (`preToolCall`), a structural type that `HookDispatcher` of plugin-host fits. The loop calls it once for each tool call before the tool runs. A block gives the tool result `{"error": "<message>"}` and runs no tool. See `packages/golden/NOTES.md`.
- Fallback seam: `LoopFallback` (`{client, model}`). A 429 or 402 from the primary rebuilds the request for the fallback client and keeps it for the rest of the turn (`pending_call.data.target`). See `packages/golden/NOTES.md`.
- Tool results are written in the order of the tool calls. Once an operation is planned, the first call that would be answered inline waits for the next pass.

## Open points

- The compression hook only checks the 50% threshold. It does not summarise.
- Results are shown only on the Node simulator, in both modes. Not shown on
  real hosts.
