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
  and discarded.
- clarify writes a question row and ends the turn. The answer is the next
  admission. The wait survives a restart (7.4 upgrade test).
- Tool schemas: clarify and todo are the literal upstream schemas.
  `terminal` is `provisional: true` (upstream file: `tools/terminal_tool.py`).
- The profile search uses FTS5 when SQLite has it, else LIKE.
  `conversation_generations` rows are never collected.
- Profile actor is fed only by the session outbox, with idempotency keys.
  Activation reconciles.

## Open points

- `session_admissions` (runtime) does not have the upstream columns. This is
  flagged and not resolved here.
- The compression hook only checks the 50% threshold. It does not summarise.
- Results are shown only on the Node simulator, in both modes. Not shown on
  real hosts.
