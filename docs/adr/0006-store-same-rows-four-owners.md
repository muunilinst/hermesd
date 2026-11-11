# 0006. Same rows at schema 32, four owners, a transactional outbox

- Status: Accepted; specified, not demonstrated
- Date: 2026-11-11
- Source: porting guide rev 5.1, sections 2.4, 6.4

## Context

Upstream's `~/.hermes/state.db` is one SQLite file per profile, at `SCHEMA_VERSION = 32`, with
17 ordinary tables, 2 FTS5 indexes, and a reply outbox the gateway creates on first use. It
holds every session of the profile, and several features read across sessions: search over
FTS5, compaction lineage through `parent_session_id`, shared memory, the cron table, the
delivery queue. A port that makes "one actor per session" the only owner breaks those silently.

The file also holds a recovery ledger: `runtime_epoch`, `session_admissions` (a durable input
FIFO, `queued → started → terminal`, `unknown` on owner loss), `worker_executions`,
`worker_receipts`, `delivery_obligations`.

## Decision

**Every table gets one decision.** `contracts/table-decisions.json` is the record.

| Tables | Decision |
| --- | --- |
| `sessions`, `messages`, `system_prompts`, `session_model_usage` | Preserve every column, in the session actor |
| `messages_fts`, `messages_fts_trigram` | Replace: platform FTS5 where it exists, else a side index; regenerated |
| `conversation_generations` | Preserve, in the profile actor; never collected |
| `runtime_epoch` | Replace by `Host.epoch()`; exported on the way back |
| `session_admissions` | Preserve as the inbox; the port does not invent a second one |
| `worker_executions`, `worker_receipts` | Preserve; the model for tool operations (reuse or a sibling table is open) |
| `async_delegations` | Preserve; an outbox for delegation results |
| `delivery_obligations` | Preserve as the reply outbox |
| `session_turn_leases`, `compression_locks` | Replace by single-writer ownership plus `Host.epoch()`; written as expired on export |
| `gateway_routing`, `gateway_hygiene_state` | Preserve, with the gateway router |
| `gateway_heartbeats` | Not supported in the actor; stays with each gateway host process |
| `state_meta`, `schema_version` | Preserve |

**Four owners.**

| Owner | Holds |
| --- | --- |
| Profile actor, one per tenant | Config, credentials, memory, skills index, cron table, `conversation_generations`, the cross-session search index, the session list |
| Session actor, one per conversation | `messages`, `session_admissions`, `session_model_usage`, the turn position, pending rows, wake obligations, outbox rows, its own compaction chain |
| Executor, one per workspace | The operation log, session minimum epochs, tombstones, the files |
| Workspace incarnation | A number in the executor cell, stored in every `pending_op` row |

**Cross-session data moves through an outbox.** The session actor writes an outbox row in the
same transaction as each commit that changes searchable text, the session list or a delivery.
A deliverer sends it with the row's ID as an idempotency key; the profile actor applies each
ID once and confirms; then the row is deleted. On activation the profile actor reconciles with
each session whose outbox is older than a threshold.

**Kept:** the preserved columns at schema 32; `parent_session_id` when compaction makes a child
session; `active=0` on rows compaction removed; a tool call and its result are never split.
Every row carries `schema_version`; a migration is a forward-only function per version that
runs on first read.

**Export and import follow upstream's recovery rule:** the four ledger tables are excluded
from a partial export, because a partial ledger could replay started effects or adopt another
owner's workers, and kept in a full one.

## Consequences

- Rollback from TypeScript to Python is a flag, not a migration, as long as both sides read and write the same rows ([0011](0011-incremental-port-flags-phases-milestone-1.md)).
- A new upstream table fails a contract test until it gets a decision.
- Search results lag a commit by one outbox delivery.
- The baseline's own `state.db` on a VM data disk is durable only at VM saves. A Python storage adapter over RPC is not recommended until someone scopes it.

## How we check it

Contract tests over `contracts/upstream/state-schema.json` and `ledger.json`. D7 (lineage) and
D12 (outbox) on the Node host. The migration test, both ways: export a `state.db` as rows,
split them into the actors, run 3 turns of which one searches, export a fresh `state.db`, run
`hermes chat --resume` on it. `packages/state-port` does all but the last step, which a person
runs with `contracts/resume-check.sh`. Drive it with the `verify-state-port` skill.
