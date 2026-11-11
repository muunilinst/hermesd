# 0003. One Host interface hides the three platforms

- Status: Accepted; the rules are specified, not demonstrated
- Date: 2026-11-11
- Source: porting guide rev 5.1, sections 2.8, 4.6, 6.8

## Context

The port must run on TeenyTiny v2, Cloudflare Durable Objects and Rivet Actors. Hermes expects
threads, blocking HTTP, a SQLite file, a file system and subprocesses; the portable subset of
the three platforms gives one event loop, `fetch` with abort, per-actor SQLite behind an API,
and no subprocess. The platforms also differ in ways that change the design: Rivet actions
interleave at every `await`; a Durable Object shutdown ends an in-flight request the moment it
touches storage; TeenyTiny acknowledges a write only when it is durable.

## Decision

Agent code imports one interface and never a platform SDK:

```ts
interface Host {
  id(): string;                               // one writer per session key
  epoch(): number;                            // owner epoch, raised at every activation
  tx<T>(fn: (sql) => T): Promise<T>;          // one atomic transaction over the rows
  commit(): Promise<void>;                    // resolves only when the rows are durable
  arm(at: Date, key: string): Promise<void>;  // durable timer; resolves when durable
  fetch(req, signal): Promise<Response>;      // outbound HTTP, abortable
  sidecar(name): RpcClient;                   // the gateway host and the executor
}
```

The seven functions hide syntax. The rules below make the platforms equally durable, and each
adapter must meet all of them:

| Guarantee | Rule |
| --- | --- |
| An owner epoch the executor can check | The adapter keeps `owner_epoch` in the actor's SQLite and raises it in the first committed transaction of each activation, before any outbound call. |
| State and intent commit together | The row that says "call pending" is written in the same `tx` as the rows it describes. |
| Every pending row has a wake obligation | Arm first, then commit. Re-arm first in the handler. A handler that finds nothing due while a turn is open arms again. |
| The timer is durable when `arm` resolves | TeenyTiny: `await setAlarm()`. Durable Objects: `setAlarm()` then `storage.sync()` (assumed, H). Rivet: `c.schedule.after()`, and the handler re-arms first because a failed run is not retried. |
| An independent sweeper | Its own actor, woken by cron. Sessions register and open each turn there synchronously. |
| Reply after durable commit | Nothing leaves the actor before `commit` resolves. |
| The inbox is authoritative | An inbound message is a `session_admissions` row first and an event second. |
| Dispatch is uncertain | A pending row with no result may have been sent. Retries reuse the row's identity. |
| Cross-actor updates use an outbox | Written in the same `tx` as the change; delivered with the row ID as an idempotency key. |
| Fencing | Every store write and executor call carries `epoch()`; a lower one is rejected. |
| Liveness | Rivet wraps the turn in `c.keepAwake`; pending I/O keeps a Durable Object; TeenyTiny moves only hibernated cells. |

Platform rules: on Rivet the turn is an `onWake` background task and incoming messages are
actions that write admission rows and return; never run the turn inside an action and never
use the deprecated Queue. TeenyTiny v2 uses the Durable Objects adapter and commits at intent
and result boundaries only.

A fourth adapter, in-memory Node, runs the tests fast.

## Consequences

- One code base runs on three platforms. The port does not use what only Rivet has (threads, processes).
- An adapter is small (the guide estimates 200 to 400 lines, H) but carries real rules; "it compiles against `Host`" proves nothing.
- A test that passes on Node and fails on a real host is a host-adapter bug.
- Open: whether Cloudflare makes an alarm durable before a later SQL commit. If not, that adapter relies on the sweep alone for D9 (a).

## How we check it

`packages/host` is the interface. `packages/host-node` simulates both rule sets with crash and
timer faults. `packages/host-cloudflare` runs on local workerd, `packages/host-rivet` on real
rivetkit. D3, D6, D8, D9 (a) to (h) and D12 run on the Node host today; the deployed hosts are
not run. Drive it with the `verify-hosts` skill.
