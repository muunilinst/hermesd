---- MODULE SessionLoop ----
\* The session actor and its agent loop (packages/session-actor/src/actor.ts, loop.ts,
\* lineage.ts; packages/runtime/src/session.ts). One session, at most one queued input,
\* at most one compaction. Each action is one commit or one in-memory event of the code.
EXTENDS Naturals

VARIABLES
  owner,      \* "up" or "down": the actor's activation
  adopted,    \* the new owner has repaired lineage, fenced and swept (#adopt)
  queue,      \* an admission with status 'queued' waits (at most one, to keep the model small)
  turn,       \* "none", "call" (pending_call), "tools" (pending_op), "held" (admission 'unknown')
  inflight,   \* the model fetch is out (memory only: a crash loses it)
  stopped,    \* loop_turn.interrupted = 1
  asking,     \* a clarify_question is open
  openCalls,  \* the transcript has an assistant tool call with no result
  cur,        \* the current session: 0 = parent, 1 = compacted child
  callSess,   \* the session that the in-flight model call's snapshot read
  link,       \* compaction_link: "none", "started" (commit 1 only), "done"
  lost        \* a step wrote its message to a session that is no longer current

vars == <<owner, adopted, queue, turn, inflight, stopped, asking, openCalls, cur, callSess, link, lost>>

Init ==
  /\ owner = "up" /\ adopted = TRUE /\ queue = 0 /\ turn = "none"
  /\ inflight = FALSE /\ stopped = FALSE /\ asking = FALSE /\ openCalls = FALSE
  /\ cur = 0 /\ callSess = 0 /\ link = "none" /\ lost = FALSE

Up == owner = "up"

\* receive: the input becomes a queued admission.
YouSend ==
  /\ Up /\ queue = 0
  /\ queue' = 1
  /\ UNCHANGED <<owner, adopted, turn, inflight, stopped, asking, openCalls, cur, callSess, link, lost>>

\* #startNext + #begin: one admission starts. An open clarify question takes the input as its answer.
TurnStarts ==
  /\ Up /\ turn = "none" /\ queue > 0
  /\ queue' = 0 /\ turn' = "call"
  /\ asking' = FALSE /\ openCalls' = FALSE
  /\ UNCHANGED <<owner, adopted, inflight, stopped, cur, callSess, link, lost>>

\* #sendCall: the snapshot is read, then the fetch goes out.
CallGoesOut ==
  /\ Up /\ turn = "call" /\ ~inflight /\ ~stopped
  /\ inflight' = TRUE /\ callSess' = cur
  /\ UNCHANGED <<owner, adopted, queue, turn, stopped, asking, openCalls, cur, link, lost>>

\* The step's write reads the current session inside its commit. Before that fix it wrote to
\* snap.sessionId, the session its snapshot read: WriteTarget == callSess breaks NoLostMessage.
WriteTarget == cur
Wrote == lost' = (lost \/ WriteTarget # cur)

ModelAnswers ==   \* text only: the turn ends 'done' (allowed after a stop too)
  /\ Up /\ turn = "call" /\ inflight
  /\ turn' = "none" /\ inflight' = FALSE /\ stopped' = FALSE /\ Wrote
  /\ UNCHANGED <<owner, adopted, queue, asking, openCalls, cur, callSess, link>>

ModelCallsTools ==  \* raced (StepRaced) after a stop
  /\ Up /\ turn = "call" /\ inflight /\ ~stopped
  /\ turn' = "tools" /\ inflight' = FALSE /\ openCalls' = TRUE /\ Wrote
  /\ UNCHANGED <<owner, adopted, queue, stopped, asking, cur, callSess, link>>

ModelAsksClarify == \* the question is the reply; the turn ends and waits for the next input
  /\ Up /\ turn = "call" /\ inflight /\ ~stopped
  /\ turn' = "none" /\ inflight' = FALSE /\ asking' = TRUE /\ openCalls' = TRUE /\ Wrote
  /\ UNCHANGED <<owner, adopted, queue, stopped, cur, callSess, link>>

ModelFails ==       \* a 4xx, a bad answer, or retries used up: #failCall
  /\ Up /\ turn = "call" /\ inflight
  /\ turn' = "none" /\ inflight' = FALSE /\ stopped' = FALSE
  /\ UNCHANGED <<owner, adopted, queue, asking, openCalls, cur, callSess, link, lost>>

ToolsFinish ==      \* every result is written and the next model call is planned
  /\ Up /\ turn = "tools" /\ ~stopped
  /\ turn' = "call" /\ openCalls' = FALSE
  /\ UNCHANGED <<owner, adopted, queue, inflight, stopped, asking, cur, callSess, link, lost>>

ToolUnknown ==      \* an outcome is unknown: #abandon answers every call, the admission is 'unknown'
  /\ Up /\ turn = "tools"
  /\ turn' = "held" /\ openCalls' = FALSE /\ stopped' = FALSE
  /\ UNCHANGED <<owner, adopted, queue, inflight, asking, cur, callSess, link, lost>>

YouResolveUnknown ==
  /\ Up /\ turn = "held"
  /\ turn' = "none"
  /\ UNCHANGED <<owner, adopted, queue, inflight, stopped, asking, openCalls, cur, callSess, link, lost>>

\* stop: the flag is committed first, then the fetch is aborted.
YouStop ==
  /\ Up /\ turn \in {"call", "tools"} /\ ~stopped
  /\ stopped' = TRUE /\ inflight' = FALSE
  /\ UNCHANGED <<owner, adopted, queue, turn, asking, openCalls, cur, callSess, link, lost>>

StopEndsTurn ==     \* #interrupt -> #abandon: cancel the ops, answer every open call
  /\ Up /\ stopped /\ ~inflight /\ turn \in {"call", "tools"}
  /\ turn' = "none" /\ stopped' = FALSE /\ openCalls' = FALSE
  /\ UNCHANGED <<owner, adopted, queue, inflight, asking, cur, callSess, link, lost>>

\* The compact call, commit 1: the child is written and becomes current.
CompactStarts ==
  /\ Up /\ cur = 0
  /\ cur' = 1 /\ link' = "started"
  /\ UNCHANGED <<owner, adopted, queue, turn, inflight, stopped, asking, openCalls, callSess, lost>>

\* Commit 2 (finishCompaction, or repairLineageRows in #adopt).
CompactFinishes ==
  /\ Up /\ link = "started"
  /\ link' = "done"
  /\ UNCHANGED <<owner, adopted, queue, turn, inflight, stopped, asking, openCalls, cur, callSess, lost>>

Crash ==
  /\ Up
  /\ owner' = "down" /\ adopted' = FALSE /\ inflight' = FALSE
  /\ UNCHANGED <<queue, turn, stopped, asking, openCalls, cur, callSess, link, lost>>

Restart ==          \* the next wake activates a new owner
  /\ owner = "down"
  /\ owner' = "up"
  /\ UNCHANGED <<adopted, queue, turn, inflight, stopped, asking, openCalls, cur, callSess, link, lost>>

Adopt ==            \* #adopt: repair lineage, fence, sweep, poke
  /\ Up /\ ~adopted
  /\ adopted' = TRUE /\ link' = IF link = "started" THEN "done" ELSE link
  /\ UNCHANGED <<owner, queue, turn, inflight, stopped, asking, openCalls, cur, callSess, lost>>

Next ==
  \/ YouSend \/ TurnStarts \/ CallGoesOut \/ ModelAnswers \/ ModelCallsTools \/ ModelAsksClarify
  \/ ModelFails \/ ToolsFinish \/ ToolUnknown \/ YouResolveUnknown \/ YouStop \/ StopEndsTurn
  \/ CompactStarts \/ CompactFinishes \/ Crash \/ Restart \/ Adopt

Spec == Init /\ [][Next]_vars

\* ---- The rules ----
\* When no turn is running, every tool call has its result (except the clarify call that waits for you).
CallsAnswered == (turn \in {"none", "held"} /\ ~asking) => ~openCalls
\* While an outcome is unknown, no later input starts a turn.
HeldMeansNoTurn == turn = "held" => ~inflight
\* Every message of a turn lands in the session that is current, so the model sees it next time.
NoLostMessage == ~lost
====
