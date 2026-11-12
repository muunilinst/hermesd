# Feature map

hermesd's features are the steps of one agent turn and the failures it must survive. Each
subsystem has its own skill, which is the feature file: it has the same four sections
(`Sub-features`, `How to get to it (user POV)`, `Driving it with verify.ts`, `Gotchas`).

| Feature | File | Drive |
| --- | --- | --- |
| Upstream contract surfaces | [verify-contracts](../../verify-contracts/SKILL.md) | `verify.ts run contracts` |
| Host adapters and runtime rules | [verify-hosts](../../verify-hosts/SKILL.md) | `verify.ts run hosts --rt node` |
| Executor contract and guest helper | [verify-executor](../../verify-executor/SKILL.md) | `verify.ts run executor --linux` |
| Session loop, prompt, providers | [verify-loop](../../verify-loop/SKILL.md) | `verify.ts run loop` |
| Plugin host | [verify-plugins](../../verify-plugins/SKILL.md) | `verify.ts run plugins` |
| Golden transcripts | [verify-golden](../../verify-golden/SKILL.md) | `verify.ts run golden` |
| Fault tests D1 to D17 | [verify-faults](../../verify-faults/SKILL.md) | `verify.ts run faults` |
| State round trip | [verify-state-port](../../verify-state-port/SKILL.md) | `verify.ts run state-port --rt node` |

## The flow of one turn

Follow a user message through the port. Each step names the subsystem that proves it. A
change to a step is verified when every subsystem on its row passes.

| # | Step | Code | Verify with |
| --- | --- | --- | --- |
| 1 | A message arrives and becomes a `session_admissions` row. The same message twice gives one row and one turn. | `runtime/src/session.ts`, `session-actor/src/actor.ts` | `hosts` (D3, inbox crash), `loop` |
| 2 | The actor is activated; the adapter raises the owner epoch in the first committed transaction. | `host-*/src/index.ts` | `hosts` (D6) |
| 3 | The session opens the turn at the sweeper, synchronously, before it accepts work. | `runtime/src/sweeper.ts` | `hosts` (D9 e, f, g) |
| 4 | The prompt is built; history over 50% of the window is compacted into a child session in two commits. | `prompt/src`, `session-actor/src/lineage.ts` | `loop` (D7), `golden` (`compaction-50`, `compaction-85`) |
| 5 | The loop arms a wake obligation, commits a `pending_call` row, then sends the request in the provider's wire format. | `session-actor/src/loop.ts`, `providers/src` | `loop` (D1), `hosts` (D9), `golden` (four `format-*` scripts) |
| 6 | The model answers with text, tool calls or a clarify question. The tool-call turn is written before any tool runs. | `session-actor/src/loop.ts` | `loop`, `golden` (`persistence-failure-before-tool`) |
| 7 | `pre_tool_call` hooks run; a block, a crash or a timeout means the tool does not run. | `plugin-host/src/hooks.ts` | `plugins`, `golden` (four hook scripts) |
| 8 | A terminal call becomes `pending_op` with an `op_id` derived from the tool call, bound to the workspace incarnation; `prepare`, then `start`. | `session-actor/src/executor-rpc.ts`, `executor-protocol/src` | `executor` (D10, D17), `loop` |
| 9 | The executor cell passes the launch to the guest helper: journal, claim file, then the command. | `executor-model/src`, `guest-helper/src` | `executor --linux` (D14, D15, D16) |
| 10 | The result comes back as an event, or `status(op_id)` finds it after a lost reply or a new owner. `unknown` holds the turn. | `session-actor/src/loop.ts`, `executor-model/src/cell.ts` | `executor` (D2, D4, D11, D13), `faults` |
| 11 | The user presses stop: the turn ends, `cancel(op_id)` is sent, a late result is discarded. | `session-actor/src/loop.ts` | `loop` (cancellation at each point), `golden` (`interrupt-mid-call`, `cancellation-during-tool`) |
| 12 | The reply is written, then leaves the actor after commit. Searchable text goes to the profile actor through the outbox. | `runtime/src/outbox.ts`, `profile-actor/src` | `hosts` (D12), `loop` |
| 13 | The rows can be exported to an upstream-shaped `state.db` and read back. | `state-port/src` | `state-port` |
| 14 | Upstream moves: the pin is bumped and the surfaces are extracted again. | `contracts/` | `contracts`, then `golden` |

A proof that drives one convenient row is incomplete when the change touches others. A change
to `loop.ts` touches rows 5, 6, 8, 10, 11 and 12: run `loop`, `golden` and `faults`.

## What no skill here can show

- Any fault test on a deployed Durable Object, a TeenyTiny fleet, or Rivet cloud.
- A real executor cell, a real VM, or systemd units in the guest.
- Upstream Hermes playing the golden scripts, or resuming an exported `state.db`.
- Plugin isolation (grant or sandbox).
- A real model provider.

[STATUS.md](../../../../STATUS.md) tracks these. Say so in a report instead of implying cover.
