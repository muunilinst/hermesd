# host-rivet notes

## Tests

- `src/index.test.ts`: 8 unit tests with a fake actor context on `node:sqlite`.
- `src/rivetkit.test.ts`: 6 tests on real rivetkit 3.0.7 (`rivetkit/test`
  `setupTest`, native engine, in this process). They ran and passed in this
  container (Linux x64). They skip with the reason if rivetkit cannot start.
  Covered: epoch rises at each wake (and equals the stored value); `tx` rolls
  back on throw, in memory and in `c.db`; a schedule fires, and the handler
  re-arms first (a failing first run is still retried); 3 parallel
  compare-and-set appends give exactly one winner; a crash before the admission
  write, or after it and before the ack, loses nothing and runs each message
  once; a turn longer than `sleepTimeout` keeps the actor awake under
  `keepAwake`, and a control actor without it sleeps.
- The first start of the engine can be slow (one run took 47 s and gave
  "registry is not ready: 503 starting", so all six skipped). A second run
  started fast. A skip is not a pass.
- The test file calls `process.exit` 2 s after the run, because the native
  runtime keeps the process alive after `registry.shutdown()`.

## Design

- `c.db` is async only, but `Host.tx` is synchronous. The adapter keeps an
  in-memory `node:sqlite` mirror, runs the callback on it, and replays the
  changing statements in one `c.db.transaction`. `tx` resolves after that
  commit. The replay also checks `owner_epoch` (fence). A failed replay breaks
  the host: later calls throw.
- The mirror is loaded in `activate` by copying every non-`_rivet` table. Size
  of the actor data is therefore bounded by memory. Not tested with large data.
- `RivetHost.of(c)` uses a module-level map keyed by `actorId`.

## Not verified

- Whether a crash (process kill) in the middle of the `c.db` replay is atomic.
  Only a thrown action was tested, not a killed process.
- That `schedule.at` is durable before a later `c.db` commit. Order is
  schedule first, then row, as in section 4.6; no test can prove durability.
- Behavior across a real node move, or a deploy during a running turn
  (section 7.4): not tested.
- API names to confirm against rivetkit docs: `c.schedule.at/cancel` (the
  cancel method), `c.keepAwake`, `c.abortSignal`, `c.sleep()`, `db()` from
  `rivetkit/db`, and the `name` option of `c.db.transaction`. They worked on
  3.0.7, but were found by reading types, not docs.
- Rivet logs a warning for unnamed SQLite transactions made by the app's own
  `c.db.execute` calls (in tests only).
