# 0002. Durable state, not replay

- Status: Accepted; milestone 1 step 9 revisits it with data
- Date: 2026-11-11
- Source: porting guide rev 5.1, section 3.3

## Context

A runtime can survive a crash in two ways. With **durable state** the program writes its
position and every value that must survive, and reads them back. With **replay** the runtime
records each step result and, after a crash, runs the function from the top and returns the
recorded values; code between steps must then reach the same steps in the same order.

All three platforms offer both: their Workflows products replay, their actors hold state. So
this is a choice.

Hermes today is durable state. It writes the tool-call turn before any side effect, keeps a
durable input queue with an `unknown` status, an owner epoch, worker receipts and a reply
outbox.

## Decision

The loop is durable state. Its position is rows in the session actor's SQLite, the same rows
upstream writes.

## Consequences

- Upstream's ledger semantics (input FIFO, `unknown` on owner loss, receipts) carry over without translation, and the rows stay interchangeable with `state.db` ([0006](0006-store-same-rows-four-owners.md)).
- A session that waits for days resumes under new code with old rows. Replay would add a determinism rule for every deployed version.
- There is one record of each fact, not a row and a step log.
- We write the recovery logic ourselves: what to do with each kind of pending row on wake ([0005](0005-loop-rows-wake-obligations-sweeper.md)).
- Replay does not remove the hard case either: an attempt whose result was not recorded may run again, so the executor contract ([0004](0004-executor-contract-unknown-is-an-answer.md)) is needed under both models.

## How we check it

The upgrade test (a clarify wait survives a restart under new code with old rows) and D1 run
in `packages/faults/src/loop`. Milestone 1 step 9 decides between this and a replay runtime
from what the fault tests and the measurements show.
