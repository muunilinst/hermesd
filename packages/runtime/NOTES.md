# Runtime notes: where the guide was open, and what we chose

Guide = porting guide rev 5.1. Each item gives the section, the question, and
the reading we took. Where two readings were possible we took the safer one.
Change an item here when the guide gets clearer.

## Host interface

1. **No clock, no wake handler in `Host` (4.6).** `Host` has 7 functions and no
   clock and no way to receive an alarm. The runtime takes a `Clock` from its
   caller. An adapter calls the actor through a small `ActorBehavior` shape
   (`activate`, `alarm`, `cron`, `call`). Each side keeps its own copy of the
   shape. They are the same, so the compiler accepts both. We did not change
   `@hermesd/host`.
2. **How an actor reaches another actor (4.6, outbox and sweeper).** The guide
   says `sidecar(name)` reaches "the gateway host and the executor". We use the
   same call for actors: the name `actor:<key>` reaches the actor with that key.
   Config holds the names (`sweeperTarget`, `profileTarget`).
3. **Where `owner_epoch` lives (4.6).** The adapter owns a table `host_state`
   in the actor's SQLite. It raises the epoch in the first committed
   transaction of each activation. The runtime only reads `host.epoch()`.
4. **Who rejects a lower epoch (4.6, "fencing").** Two places. The adapter's
   `tx` refuses a write from an activation that has a lower epoch than the
   store. The receivers (sweeper, profile stub) keep the highest epoch seen per
   caller and refuse a lower one. The executor's fence is not in this change.

## Wake obligations (4.6)

5. **Who computes the earliest obligation.** `arm(at, key)` is `setAlarm`: it
   replaces. So the runtime arms the *earliest open obligation* each time, not
   the new one, when an older one is still open. On Rivet (one timer per key)
   the runtime uses the same key for the earliest obligation, so one entry is
   replaced and not duplicated. A race can still leave the alarm later than an
   older obligation (two arms interleave). Then the older obligation is late,
   not lost: the next alarm runs the handler, and the sweeper covers the rest.
6. **"At least a minimum delay after the arm".** A new obligation is due at
   `max(requested, now + minDelay)`. The handler's own re-arm of an existing
   obligation is not held to this: it keeps the due time of the next obligation.
   A due obligation that the handler works on is moved to `now + minDelay`
   first ("a retry of the current one").
7. **"Re-arm for one minimum delay later" in case (h).** If the handler finds
   nothing due, it re-arms the next open obligation at its own due time (the
   timer fired early; the work is still in the future). Only if there is no open
   obligation at all, and a turn is open, does it add a `recheck` obligation due
   at `now + minDelay`. Either way an open turn is never left without a timer.
8. **What is a "pending row" for a turn.** A turn start commits, in one
   transaction after the arm: the admission becomes `started`, the turn row is
   written, and a `turn` obligation is written (guide 4.3: "mark the turn as
   running, with a wake obligation, in a committed transaction before it calls
   the model"). Each later step (`ctx.pend`) writes a pending row and its own
   obligation the same way. The turn obligation stays open until the turn ends.
9. **Wake of a queued admission with no obligation (case a).** The handler
   does no obligation work, and then drains the inbox like every wake does. So
   in case (a) the wake is a no-op for obligations, and the queued admission is
   then started once. We did this so that a queued admission cannot wait for
   ever when its first arm failed (case c) or crashed (case a).
10. **What a wake does with an open turn (6.3).** Pending rows without result:
    call `driver.resume` (the driver treats them as "may have been sent" and
    counts `attempts`). No pending row and no recorded step: call `driver.start`
    again (nothing was sent). A step is done and the next is not recorded: mark
    the turn and its admission `unknown`, as upstream does on owner loss. We do
    this at the wake, not at activation, so that a turn whose obligation fires
    can still be resumed.
11. **Give up.** The runtime does not count wakes. The driver gives up with a
    visible error when `attempts` is too high (the scripted test driver does
    after 3). The runtime counts only driver *failures* (exceptions) without a
    recorded step; after 5 it ends the turn with a visible error.
12. **A driver that is running in this activation** is not started again by a
    wake (`active` set). The re-arm in the handler already covers the next wake.

## Inbox and outbox (4.6, 6.4)

13. **Terminal admission statuses.** `done` and `failed`. Plus `unknown`. A
    later input waits while an admission is `started` or `unknown`.
14. **Registration.** A session registers with the sweeper in `activate()` and
    again, if needed, at the start of `receive`. If the sweeper is down,
    `receive` fails and nothing is acknowledged, so the sender retries.
15. **Sweeper open before the turn row.** The turn id is `turn-<admission id>`.
    `open` runs before the arm and the commit, as the guide says, so a crash
    can leave an open record for a turn that has no row. On a sweeper wake the
    session closes (through the outbox) the turns that it does not have open and
    that no queued admission will open.
16. **Horizon.** 10 min by default. A turn extends it when less than half is
    left, at a wake and before a `pend`. If the extension fails, the step does
    not go on.
17. **Outbox idempotency key.** `<session id>#<outbox row id>`. Row IDs use
    `AUTOINCREMENT`, so an ID is never used again after a delete.
18. **Profile stub reconcile.** It asks every *known* session (a test registers
    them) with threshold 0. The real profile actor must learn its sessions from
    the session list. The stub index is a `LIKE` search, not FTS5.

## Node adapter (4.5, 4.6, 7.4)

19. **Durable Objects mode, writes.** `tx` writes into a buffer. Rows become
    durable at `commit()`, at `arm()` (the guide's `setAlarm` then
    `storage.sync()`), before any output leaves (reply, `fetch`, sidecar call),
    and at the end of an event. A crash drops the rows that are not durable. That
    `sync()` makes the alarm durable before the next commit is the guide's open
    question 6; the simulator assumes it, as the guide does.
20. **Input gate.** A storage call (`tx`, `commit`, `arm`) blocks the start of
    new events from its first line until it finishes. An awaited `fetch` or
    sidecar call does not. An event that waits is started one at a time.
21. **Alarm retry.** Durable Objects mode: up to 6 retries, 2 s base, doubled.
    Rivet mode: none. Tests can override this (case f runs with it off on both).
22. **"Two parallel actions must not both append" (7.4, Rivet).** We read it as:
    the runtime must be safe without the input gate. Appends are compare-and-set
    in one transaction (`expectedTail`), and inbound actions only write an
    admission row; one background task starts turns, one at a time. A platform
    test shows that a naive read, await, write loses an update on the Rivet rules
    and not on the Durable Objects rules.
23. **Split brain.** `splitBrain(key)` is a test hook that breaks the platform's
    one-writer rule on purpose. It starts a second activation that shares the
    storage.

## Not in this change

- Executor fence, op_id, incarnation (other worker).
- FTS5, the real cron table, the model call and tool loop (a `TurnDriver`
  comes from the application).
- Real hosts. A pass on this adapter does not make a mechanism *demonstrated*
  (STATUS.md rule).
