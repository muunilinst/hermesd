# Session loop statechart

A TLA+ model of one session actor (`packages/session-actor/src/actor.ts`, `loop.ts`,
`lineage.ts`, `packages/runtime/src/session.ts`): its turns, the stop and clarify paths, an
unknown tool outcome, the two-commit compaction, and a crash with a new owner. TLC checks the
rules below on every state; the chart is drawn from the same run.

```mermaid
---
title: "hermesd session actor: one session, its turns, compaction and restarts"
---
stateDiagram-v2
  direction LR
  state "Legend" as legend {
    lg0: No turn running
    lg1: Turn running
    lg2: Held
  }
  class lg0 teal
  class lg1 blue
  class lg2 orange
  state "At the same time" as all {
    state "Turn" as r0 {
      s0: Idle
      s1: Model call written
      s2: Waiting for the model
      s3: Stopping
      s4: Running tools
      s5: Waiting for your answer
      s6: Held: a tool outcome is unknown
      [*] --> s0
      s0 --> s1: your next input starts a turn [when Owner is not Crashed]
      s1 --> s2: the model call goes out [when Owner is not Crashed]
      s1 --> s3: you press stop [when Owner is not Crashed]
      s2 --> s0: the model replies with text or the model call fails
      s2 --> s1: the owner crashes
      s2 --> s3: you press stop
      s2 --> s4: the model asks for tools
      s2 --> s5: the model asks you a question
      s3 --> s0: the stop ends the turn [when Owner is not Crashed]
      s4 --> s1: the tools finish [when Owner is not Crashed]
      s4 --> s6: a tool outcome is unknown [when Owner is not Crashed]
      s4 --> s3: you press stop [when Owner is not Crashed]
      s6 --> s0: you resolve the unknown outcome [when Owner is not Crashed]
      s5 --> s1: your next input starts a turn [when Owner is not Crashed]
      s3 --> s6: a tool outcome is unknown [when Owner is not Crashed]
    }
    --
    state "Compaction" as r1 {
      s7: Not compacted
      s8: Child written, parent not retired
      s9: Compacted
      [*] --> s7
      s7 --> s8: you compact (commit 1) [when Owner is not Crashed]
      s8 --> s9: commit 2 retires the parent [when Owner is not Crashed]
      s8 --> s9: the new owner adopts (repair, fence, sweep) [when Owner is Restarted, not adopted yet]
    }
    --
    state "Owner" as r2 {
      s10: Running
      s11: Crashed
      s12: Restarted, not adopted yet
      [*] --> s10
      s10 --> s11: the owner crashes
      s11 --> s12: a wake starts a new owner
      s12 --> s10: the new owner adopts (repair, fence, sweep)
      s12 --> s11: the owner crashes
    }
  }
  class s0 teal
  class s1 blue
  class s2 blue
  class s3 blue
  class s4 blue
  class s5 teal
  class s6 orange
```

## Rules

| Rule | In words | Status |
|---|---|---|
| `CallsAnswered` | When no turn runs, every tool call has its result, except the clarify call that waits for you. | holds |
| `HeldMeansNoTurn` | While a tool outcome is unknown, no model call is out. | holds |
| `NoLostMessage` | Every message a turn writes lands in the session that is current, so the model sees it next time. | holds since the fix below |

`NoLostMessage` broke on the code before this commit. Path: you send a message, the turn
starts, the model call goes out, you compact (commit 1 makes the child current), the model
replies. The step wrote the reply to `snap.sessionId`, the parent read before the fetch, so the
reply sat in the retired parent and the child never saw it. `packages/faults/src/loop/compact-race.test.ts`
replays that path; the step now reads the current session inside its commit. Set
`WriteTarget == callSess` in the spec to see the old path again.

## What the model leaves out

One queued input at a time, one compaction, no in-turn window compression (`writeWindowChild`),
no fallback model, no retries or wake obligations (a crash just loses the fetch and the next
wake resends it), no executor fence or sweep detail beyond "adopt". The chart hides no steps;
"you send a message" stays in one chart state, so it has no arrow.

## Make it again

With the statechart skill (https://github.com/cursor/plugins/tree/main/pstack/skills/statechart):

```sh
<skill dir>/scripts/statechart docs/statecharts/session-loop/SessionLoop.tla \
  --view docs/statecharts/session-loop/view.ts --out /tmp/session-loop-chart
```

Set `TLA2TOOLS` (tla2tools.jar 1.7.4) and `JAVA` to skip the mise install.
Copy the new `chart.mmd` here and into the block above.
