# host-cloudflare notes

## Tests

- `src/index.test.ts`: 10 unit tests with a fake `ctx` on `node:sqlite`.
- `src/workerd.test.ts`: 5 tests on real workerd (Miniflare 4.20260730.0,
  workerd 1.20260730.1). The test strips the types from `src/index.ts` with
  `node:module` `stripTypeScriptTypes` and loads it with `test-worker/worker.js`.
  If Miniflare cannot start, the tests skip with the reason.
- The restart is `ctx.abort()` inside the object. It resets the object, and the
  next request builds a new instance. A full workerd process restart is not tested.
- "Commit before reply" is only tested from outside: write, `commit()`, reply,
  abort, read. Miniflare cannot show the output gate holding a reply.
- Section 7.4, immediate code update with a 60 s model call: NOT done. Miniflare
  has no "deploy a new version while a request runs" step. It needs a deployed
  Worker (or `wrangler versions deploy` with a code update strategy).

## TeenyTiny differences to check (source: cloudflare-compat.md in muunilinst/caas)

Not read. These must be checked against it:

- `transactionSync` and `ctx.storage.sql` exist, and `exec` returns a cursor with `toArray()`.
- `ctx.storage.sync()`: exists? What does it wait for (bucket proof, fleet proof)?
- `setAlarm`/`getAlarm`/`deleteAlarm`, one alarm per object, retry count and backoff.
  The guide says `setAlarm()` is answered only after a durable wake entry, so
  the extra `sync()` in `arm` may be redundant there.
- `blockConcurrencyWhile` and input/output gate rules. Does a reply wait for the
  durability proof?
- `ctx.id.name` (we fall back to `id.toString()`), `ctx.abort()`.
- `AbortSignal.any`, `Request` with `signal`, service bindings (`env.X.fetch`).
- Whether `DurableObject` base class from `cloudflare:workers` exists.
- Alarm behavior on a node change: does the new owner fire an alarm that was set earlier?
- Fencing epoch in the storage prefix versus our `owner_epoch` row: both are kept.
- Hibernation and eviction rules, and the handler wall-clock budget instead of `limits.cpu_ms`.

## Ambiguous or open

- Guide open question 6: alarm durable before a later SQL commit on Cloudflare
  is ASSUMED (`setAlarm` + `sync`). No test here can prove it.
- Does `sync()` cover alarm writes? The docs describe it for storage writes.
- The minimum delay (30 s) is the runtime's job. `arm` does not enforce it.
- `wake_timers` rows stay after the alarm fires until the runtime calls
  `disarm(key)`. `disarm` and `onAlarm` are not in `Host`. The runtime author
  must decide if they go into the interface.
- Sidecar wire format (`POST /rpc`, JSON `{method, params}`, header
  `x-hermesd-epoch`, JSON reply) is my choice. Align it with
  `@hermesd/executor-protocol`.
- `epoch()` is synchronous and throws before activation ends. `blockConcurrencyWhile`
  means normal event handlers never see that.
- If activation fails, `ready` rejects and `blockConcurrencyWhile` resets the object.
