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
