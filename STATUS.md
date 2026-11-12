# Status

This file shows what is specified and what is demonstrated. It follows
section 10.1 of the porting guide (rev 5.1).

- **Specified**: the rules are written down.
- **Demonstrated**: the fault test passed on a real host, with a real
  executor, a real guest helper and a real VM.

A pass on the in-memory model or on in-memory Node does not make a mechanism
demonstrated. Change a row only in the same change that adds the evidence.

## Mechanisms

| Mechanism | Guide section | Status | Decided by |
| --- | --- | --- | --- |
| Table decisions against upstream's ledger | 2.4 | Specified | Contract tests 5 and 6 |
| Derived operation IDs, idempotent prepare | 3.4 | Specified | D10, D17 |
| Owner epoch, fence, adoption | 3.4, 4.6 | Specified | D2, D6, D13, D17 |
| Workspace incarnation through the VM lifecycle | 3.4 | Specified | D11 (a) to (e) |
| Guest launch journal, claim file, reconciliation | 3.4 | Specified | D14 (a) to (d), D15, D16 |
| Wake obligations and independent sweeper | 4.6 | Specified | D9 (a) to (h) |
| Transactional outbox | 4.6, 6.4 | Specified | D12 |
| Plugin grant or sandbox | 3.5, 6.6 | Specified | Phase 4 isolation tests |

## Fault tests

Columns are hosts. `-` means not run. `model` is the in-memory executor
model, `node` is the in-memory Node host (both Durable Objects and Rivet rule
sets), and `guest-process` is the guest helper prototype with real child
processes and files but no systemd and no VM. None of these three
demonstrates a mechanism.

| Test | Phase | model | node | guest-process | durable-objects | teenytiny-1node | teenytiny-2node | rivet |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | 1 | - | pass | - | - | - | - | - |
| D2 | 0 | pass | pass (actor side) | - | - | - | - | - |
| D3 | 1 | - | pass | - | - | - | - | - |
| D4 | 0 | pass | - | - | - | - | - | - |
| D5 | 0 | pass | pass (actor side) | - | - | - | - | - |
| D6 | 1 | - | pass (store side) | - | - | - | - | - |
| D7 | 1 | - | pass | - | - | - | - | - |
| D8 | 1 | - | pass | - | - | - | - | - |
| D9 | 1 | - | pass | - | - | - | - | - |
| D10 | 0 | pass | pass (actor side) | - | - | - | - | - |
| D11 | 0 | pass | - | - | - | - | - | - |
| D12 | 1 | - | pass | - | - | - | - | - |
| D13 | 0 | pass | pass (actor side) | - | - | - | - | - |
| D14 | 0 | - | - | pass | - | - | - | - |
| D15 | 0 | - | - | pass | - | - | - | - |
| D16 | 0 | pass (cell side) | - | pass | - | - | - | - |
| D17 | 0 | pass | pass (actor side) | - | - | - | - | - |

Phase 0 runs against the executor with upstream Hermes as the agent, so the
actor hosts do not apply to its tests until phase 3 reruns them.

## The milestone 1 world on real runtimes, run locally

`packages/stack` runs the whole world (session, sweeper, profile, executor model,
gateway, scripted model) on real workerd (Miniflare 4.20260730.0) and real
rivetkit 3.0.7, in one process on one machine. The crash is the platform's own:
`ctx.abort()` on workerd, `c.sleep()` at the fault point on rivetkit. The executor is
still the in-memory model and there is no VM, so none of this demonstrates a mechanism.

| Scenario (packages/stack/src/scenarios.ts) | node | workerd (local) | rivetkit (local) |
| --- | --- | --- | --- |
| A plain turn | pass | pass | pass |
| A terminal call runs once | pass | pass | pass |
| A model call longer than the idle sleep timeout, one request | pass | pass | pass |
| D3 same message twice, one turn | pass | pass | pass |
| D1 eviction while the model call is open | pass | pass | pass |
| D1 crash after the request left | pass | pass | pass |
| D9 (b) crash before the request leaves, the wake alone resumes | pass | pass | pass |
| D2 actor side, eviction while a command runs | pass | pass | pass |
| D12 crash before the index update, the outbox catches up | pass | pass | pass |

Step 8 numbers from these runs are in `bench/`.

## Other tests from guide 7.4

| Test | node |
| --- | --- |
| Cancellation at each point of a turn | pass |
| Clarify wait survives a restart under new code with old rows | pass |
| Inbox crash between receive and admission write | pass |
| Two parallel Rivet actions do not both append | pass |
| Immediate code update during a 60 s model call (Durable Objects) | needs a deployed Worker |

## Open questions (guide section 10.3)

1. Which TeenyTiny VM evidence is current (real KVM or PVM host)?
2. Where do command receipts live: the VM's namespace cell or a dedicated
   executor cell?
3. Do tool operations reuse `worker_executions` and `worker_receipts`?
4. Does anyone depend on native Python plugins today?
5. Must a workspace survive host loss with unsaved disks, or only Stop and
   Start?
6. Does Cloudflare make an alarm durable before a later SQL commit?
7. Does the VM status mean what the incarnation rule needs?
8. Will TeenyTiny take the guest helper change?
9. Coding agent over an API, or personal agent on chat platforms?
