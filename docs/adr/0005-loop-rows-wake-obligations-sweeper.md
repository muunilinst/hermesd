# 0005. Every blocking call becomes a row and a return

- Status: Accepted; specified, not demonstrated
- Date: 2026-11-11
- Source: porting guide rev 5.1, sections 2.3, 6.3, 4.6

## Context

Upstream runs one turn in six steps: build the prompt, compress if over 50%, call the model,
persist and run tools, append results, write SQLite. Three of them (the model call, the tools,
the write) block an operating-system thread. An actor has no thread to block, and it can be
shut down or moved at any `await`.

A row does not make an HTTP request durable. After a shutdown nobody may receive the response,
and without something to come back, nothing would ever return to the row.

## Decision

Each blocking step becomes "write a pending row, return, resume on the next event". The row is
the loop's position. Keep upstream's order: the intent is durable before the effect starts.

- **Model call:** arm the wake obligation, commit `pending_call` and the obligation in one transaction, then send.
- **Tool calls:** as upstream, persist the tool-call turn first. Write one `pending_op` per tool with its `op_id` and an obligation, commit, call `start`. Results are events.
- **SQLite write:** already a row; write it before the reply leaves the actor.

What the actor does with a row it finds on wake:

| Row | Action |
| --- | --- |
| `pending_call`, no response | Re-send with the same `call_id`, count the retry, give up after 3 with a visible error. A model call has no effect in the world except cost. |
| `pending_op`, no result | Never mint a new identity. Call `status(op_id)`: record `done` or `failed`; `start` a `prepared` one; wait on `dispatching` or `running`; `prepare` and `start` again with the stored incarnation if there is no record; record `unknown` on `expired` or `unknown`. |
| `pending_op` is `unknown` | Mark the turn's admission `unknown`, ask the user, and hold later inputs until it is resolved. |

There is no local "sent" flag. A response that arrives after a shutdown and cannot be written
is treated as no response.

**Wake obligations.** Arm first, then commit; a failed arm means no commit. The handler's first
durable action is to re-arm. The due time is at least a minimum delay after the arm (30 s by
default). A handler that finds nothing due while a turn is open arms again.

**The sweeper.** Its own actor, woken by cron, not by any session. A session registers with it
synchronously when created, and calls `open(session, turn, horizon)` synchronously before each
turn's first pending row; if that call fails, the turn does not start. `close` goes through
the outbox. The sweeper wakes every session whose open turn is past its horizon, so it never
depends on an outbox delivery to learn that a session has work.

**Kept from Hermes:** compression at 50% and 85%, an interrupt drops partial output, clarify
forces tools to run one at a time.

**Where the port differs, on purpose.** Upstream marks a started input `unknown` on owner loss
and never replays it. The port resumes a turn whose next step is fully recorded, and falls
back to `unknown` otherwise. On export an in-flight turn is written as `started`.

## Consequences

- A new owner continues a turn from rows alone. Nothing in memory is needed.
- Every pending row costs a timer. On one-alarm platforms the alarm is set to the earliest due obligation.
- A model call can be sent twice and answered differently. That is fine, because nothing was shown to the user.
- The resume extension is not covered by the upstream ledger surface; D1 and D9 test it.

## How we check it

`packages/session-actor/src/loop.ts` and `actor.ts`; `packages/runtime` for obligations,
outbox, inbox and sweeper. `docs/statecharts/session-loop` is a TLA+ model of one session with
three checked rules. D1, D3, D7, D8, D9 (all eight cases) and D12 run on the Node host.
Drive it with the `verify-loop`, `verify-hosts` and `verify-faults` skills.
