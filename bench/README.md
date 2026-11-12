# Step 8: the port against an always-on VM

Milestone 1 step 8 (guide 10.2) measures memory, awake time, rows and commits per turn, and wake
latency. The baseline is upstream Hermes on an always-on VM (design doc goals 1 to 4).
Measured on 2026-11-12. The port numbers were regenerated after the third PR #4 review.

None of this is a deployment. The port ran on real workerd (Miniflare) and real rivetkit, both
local, with the in-memory executor model and no VM. Upstream ran in a real VM, but on a laptop.
Read the numbers as "same order of magnitude, same shape", not as production figures.

## What ran

| | Upstream baseline | Port |
| --- | --- | --- |
| Code | hermes-agent a9ff979 (0.23.0), `hermes gateway run` with its API server | this branch, `packages/stack` |
| Where | OrbStack Ubuntu 26.04 VM, aarch64, 10 vCPU, 9 GB, on an M3 Pro | cloud container, x64; workerd through Miniflare 4.20260730.0, rivetkit 3.0.7 |
| Model | `packages/golden/scripted-server` over HTTP, no delay | `ModelService` in process, no delay |
| Raw data | `bench/upstream/baseline.{md,json}`, `bench/upstream/work/results/` | `bench/port-*.json` |
| How to rerun | `packages/golden/UPSTREAM.md`, `bench/upstream/baseline.md` | `bun packages/stack/src/bench-cli.ts node workerd rivet --turns 20 --model-ms 0 --tool-every 0` (or 1) |

### How each side is timed

- **Turn latency.** Upstream times the HTTP request from send to response. The port starts its
  clock when the turn is sent to the gateway and stops it at the gateway's own delivery stamp
  (`StackReply.at`), so polling delay and control RPCs are excluded. A sample counts only if the
  reply carries the scripted text and no error, and the turn made the expected number of model
  requests. Both sides use the same percentile method: linear interpolation at rank q·(n−1).
- **Cold wake.** The port evicts the actor, then starts the clock *before* the request that
  activates it again (`evict` sends the actor nothing). The interval runs to the model request,
  so it includes activation. A sample counts only if the session was activated exactly once
  and the first event of that activation was the timed request (by its request id). A sample
  where an alarm (counted at platform entry, even one with no due work), a sweep or another call
  woke the actor first is rejected and retried. Each Rivet stack runs on its own engine store; runs
  before the third review shared `~/.rivetkit`, because under Bun a `process.env` assignment does
  not reach the native engine.
- **Counters.** Background work (the outbox delivery and the profile update) is drained before
  counters are reset and again before the final snapshot is taken.

## Results

Medians, with p95 in brackets. Each row is 20 turns. A "tool turn" is one terminal call and then a
reply. Upstream's values were recomputed with the interpolated percentiles and did not change.

| | Upstream, always-on VM (historical, pending re-run) | Port on workerd (local) | Port on rivetkit (local) |
| --- | --- | --- | --- |
| Plain turn, send to delivery | 96 ms (154) | 15 ms (19) | 134 ms (165) |
| Tool turn, send to delivery | 156 ms (215) | 28 ms (36) | 191 ms (211) |
| Start before the first turn | process start: 2.9 s to /health, 3.8 s to the first reply | actor activation: 13 ms from the waking send to the model request (9 to 10 ms warm) | actor activation: 123 to 131 ms (80 ms warm) |
| Memory | 246 MiB after start, 287 to 302 MiB after 40 turns, 255 MiB idle, held all month | billed at 128 MB per object, only while a turn or its I/O is open | not measured |
| Idle CPU | 1.72% of one core | not measured | not measured |

The two start rows measure different things. Upstream's number is the whole process starting.
The port's number is one actor activating, with the platform already running.

Idle CPU on the port is not measured. Nothing is held in memory between turns, but the harness
schedules sweeper work between turns, and no idle window was sampled. Don't read the blank as zero.

### Storage work per turn

These columns count different operations, so the table does not say which side commits less.

| | Upstream: SQLite WAL commit frames | Port: `Host.commit()` durability waits | Port: transactions (`tx`) | Port: rows changed | Port: adapter rows + timer calls |
| --- | --- | --- | --- | --- | --- |
| Plain turn | 14 to 15 | workerd 18, rivet 18 | workerd 42, rivet 43 | 59 | workerd 6 + 6, rivet 7 + 9 |
| Tool turn | 19 to 20 | workerd 24, rivet 24 | workerd 60, rivet 62 | 91 to 92 | workerd 8 + 8, rivet 8 + 13 |

- A `Host.commit()` waits until earlier writes are durable. On workerd and Rivet the writes
  themselves run inside `tx()`, and the platform decides how many storage commits that takes.
  Upstream's figure is WAL commit frames read from the WAL header. Neither column is a count of
  the other's operation.
- Adapter rows are the adapters' own `wake_timers` inserts and deletes. Timer calls are
  `setAlarm` and the Rivet equivalent, including those made during disarm and alarm handling.
  Both now go through an `onWrite` hook on the adapter.
- Upstream's WAL deltas need a re-run on the Mac (see below).

## Fault experiments

Each side was put through a different fault. The rows below say which.

| Fault | Upstream (3 runs, historical, pending re-run) | Port (D1 and D2, on node, workerd and rivetkit) |
| --- | --- | --- |
| What dies | the whole `hermes gateway run` process, by `kill -9`. The gateway, the agent loop and the command's process group all go. | one session actor, evicted by the platform. The gateway, the executor model and the model service keep running. |
| During a model call | the reply never arrives and no new model request is made. Admission stays `unknown`, and a retry gets 409. | the new activation sends the call again under the same nonempty call id. The model sees a second request, and one reply is delivered (D1). |
| During a command | the command dies with the gateway. There is no result row, admission stays `unknown`, and a retry gets 409. | the actor is evicted after the executor has recorded one execution of the held command. Recovery finishes the turn, and the run count is still one (D2, actor side). |

What this shows, and what it does not:

- The port survives losing the session actor, which is the failure a Durable Object or a Rivet
  actor eviction produces. It was not tested against losing the gateway or the executor, which
  is what upstream's kill does to it.
- "The command runs once" rests on the in-memory executor model. The far side of a command (a
  real executor cell, the guest helper and the VM) is milestone 1 step 2, which is still blocked.
- Upstream's kill samples need a re-run. The old driver killed after a 60 s wait even when it
  had not seen the trigger. The fixed driver marks such a sample invalid.

## Cost per user-month

`packages/stack/src/cost.ts` uses list prices read on 2026-11-12, 900 turns a month (about 30 a
day), half of them tool turns, and 50 MB of history. This is marginal cost: a plan's free
allowances are left out because every user of an account shares them.

| | Per user-month |
| --- | --- |
| Always-on VM: Hetzner CPX02, 1 vCPU, 1 GB (the cheapest plan you can order; upstream's 250 to 300 MiB fits) | $8.09 |
| Port on Durable Objects (workerd counts, average of plain and tool runs): requests $0.001, duration under $0.001, rows written $0.08, storage $0.01 | **about $0.09, partial** |

The estimate is partial. It now includes adapter writes and every `setAlarm`, but it leaves out:

- rows written to indexes. SQLite's `total_changes()` counts table rows, and Durable Objects
  also bill index rows.
- rows read, which are billed but cheap. Storage is an assumption.
- the gateway and sidecar requests that carry an event. Only events that reached the actor are
  counted.

On node there is no adapter, so alarm rows are estimated as one per arm.

Rows written are most of the port's cost. Duration is small even though Cloudflare bills the
model wait (pending I/O keeps the object in memory), because a turn is short. A real model call
adds duration: at 128 MB, every 10 s of model wait costs $0.000016, so 900 such turns add $0.014.
`busyExclModelMs` now subtracts the model-wait intervals, including waits nested inside alarms
and pokes. On Rivet, `busyMs` includes the time spent in native database transactions.

Not in the port's number: the workspace VM, which runs only while a tool needs it. Its cost and
its start time are not measured (TeenyTiny step 2). The model costs the same on both sides and is
left out.

## What the numbers say

Only the cost comparison stands now. The speed and reliability comparisons wait for validated
upstream runs (next section). The upstream latency and kill figures in this file are historical:
they came from a driver that accepted replies without checking them, and that could kill the
gateway before the intended trigger. They are kept, labelled, and not used for a conclusion.

1. **Cheaper.** Even if the missing items doubled the estimate, the port would cost about 45
   times less to host than the always-on VM, before the workspace VM. This rests on upstream's
   memory footprint and on list prices, not on the figures that need a re-run. Rows written
   decide the port's bill, so fewer rows per turn is the lever.
2. **Faster: not yet concluded.** The port's own figures are validated: on workerd a turn adds
   about 15 to 28 ms, and an evicted session reactivates in under 20 ms. rivetkit on its local
   engine adds about 135 to 190 ms a turn, which goes to actor-to-actor calls through the
   engine. The upstream side of the comparison is pending a validated run.
3. **More reliable: not yet concluded.** The port finishes the turn when its session actor is
   lost mid-model-call or mid-command, on all three hosts, and that result is validated. The
   upstream kill samples are pending a validated run, and they test a different fault (the whole
   gateway process). Gateway and executor loss on the port have not been measured.

## Needs a re-run on the Mac

The upstream driver scripts were fixed after review without being re-run (`bench/upstream/baseline.md`
has the details). These numbers need a re-run before they are trusted:

- the kill -9 samples
- the clean-pass latency
- the WAL deltas
- the Bedrock and named-provider transcripts

## Not measured yet

- Memory per idle session on TeenyTiny (density), and a deployed Worker.
- Idle CPU on the port.
- The workspace VM: start time and cost (step 2).
- The compaction-50 and compaction-85 upstream transcripts. Hermes refuses a context window under 64K.
