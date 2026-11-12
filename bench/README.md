# Step 8: the port against an always-on VM

Milestone 1 step 8 (guide 10.2): memory, awake time, rows and commits per turn, wake
latency. The baseline is upstream Hermes on a VM that is always on (design doc goal 1 to 4).
Measured 2026-11-12.

None of this is a deployment. The port ran on real workerd (Miniflare) and real rivetkit,
both local, with the in-memory executor model and no VM. Upstream ran in a real VM, but on a
laptop. Read the numbers as "same order of magnitude, same shape", not as production figures.

## What ran

| | Upstream baseline | Port |
| --- | --- | --- |
| Code | hermes-agent a9ff979 (0.23.0), `hermes gateway run` with its API server | this branch, `packages/stack` |
| Where | OrbStack Ubuntu 26.04 VM, aarch64, 10 vCPU, 9 GB, on an M3 Pro | cloud container, x64; workerd through Miniflare 4.20260730.0, rivetkit 3.0.7 |
| Model | `packages/golden/scripted-server` over HTTP, no delay | `ModelService` in process, no delay |
| Raw data | `bench/upstream/baseline.{md,json}`, `bench/upstream/work/results/` | `bench/port-*.json` |
| How to rerun | `packages/golden/UPSTREAM.md`, `bench/upstream/baseline.md` | `bun packages/stack/src/bench-cli.ts node workerd rivet --turns 20 --model-ms 0 --tool-every 0` (or 1) |

## Results

Medians, with p95 in brackets. 20 turns each. "Tool turn" means one terminal call and then a reply.

| | Upstream, always-on VM | Port on workerd (local) | Port on rivetkit (local) |
| --- | --- | --- | --- |
| Plain turn, send to reply | 96 ms (154) | 26 ms (36) | 158 ms (165) |
| Tool turn, send to reply | 156 ms (215) | 31 ms (55) | see below |
| Start before the first turn | 2.9 s to /health, 3.8 s to the first reply | cold wake: 18 ms send-to-model (10 ms warm) | cold wake: 113 ms (81 ms warm) |
| Memory | 246 MiB after start, 287 to 302 MiB after 40 turns, 255 MiB idle, held all month | billed at 128 MB per object, only while a turn or its I/O is open | not measured |
| Idle CPU | 1.72% of one core | none: nothing is in memory between turns | none |
| Durable commits per plain turn | 14 to 15 WAL commits | 18 commits, 59 rows changed, 4 alarm sets | 18 commits, 59 rows |
| Durable commits per tool turn | 19 to 20 WAL commits | 24 commits, 91 rows, 6 alarm sets | see below |
| kill -9 while the model call is open (3 runs) | the reply never arrives; no new model request; admission stays `unknown`; a retry gets 409 | the wake re-sends the call under the same call id; one reply (D1, passes on node, workerd, rivetkit) | same |
| kill -9 while a command runs (3 runs) | the command's process group dies with the gateway; no result row; admission `unknown`; a retry gets 409 | the command runs once and the turn finishes (D2 actor side) | same |

The port's kill result rests on the in-memory executor model. The far side of a command (a
real executor cell, guest helper and VM) is milestone 1 step 2 and is still blocked, so
"the command runs once" is shown for the actor side only.

## Cost per user-month

`packages/stack/src/cost.ts`, list prices read 2026-11-12, 900 turns a month (about 30 a day),
half of them tool turns, 50 MB of history. Marginal cost: the free allowances of a plan are left
out because every user of an account shares them.

| | Per user-month |
| --- | --- |
| Always-on VM: Hetzner CPX02, 1 vCPU, 1 GB (the cheapest orderable plan; upstream's 250 to 300 MiB fits) | $8.09 |
| Port on Durable Objects: requests $0.0009, duration $0.0005, rows written $0.072, storage $0.01 | $0.083 |

Rows written are 85% of the port's cost: about 75 rows and 5 alarm sets per turn. Duration is
small even though Cloudflare bills the model wait (pending I/O keeps the object in memory),
because a turn is short. The real model call will add duration: at 128 MB, every 10 s of model
wait costs $0.000016, so 900 such turns add $0.014.

Not in the port's number: the workspace VM, which runs only while a tool needs it. Its cost
and its Start time are not measured (TeenyTiny step 2). The model itself costs the same on both
sides and is left out.

## What the numbers say

1. **Cheaper.** About 100 times cheaper than the always-on VM on hosting, before the
   workspace VM. Rows written decide the port's bill; fewer commits per turn is the lever.
2. **Faster.** On workerd, a turn adds about 26 to 31 ms against upstream's 96 to 156 ms,
   and a sleeping session wakes in under 20 ms against about 3 s for a cold Hermes. rivetkit
   on its local engine adds about 160 ms a turn; the time goes to actor-to-actor calls through
   the engine and is worth a look before Rivet is called "as fast".
3. **More reliable.** Upstream loses the turn at a kill -9 in both cases, with no retry. The
   port finishes it in both cases, on all three hosts. This is the gap the port exists to
   close, and it is now measured on both sides, with the actor-side caveat above.

## Not measured yet

- Memory per idle session on TeenyTiny (density), and a deployed Worker.
- The workspace VM: Start time and cost (step 2).
- Rivet tool turns: the all-tool-turn bench stalled at the 7th turn on rivetkit; under investigation.
- compaction-50 and compaction-85 upstream transcripts: Hermes refuses a context window under 64K.
