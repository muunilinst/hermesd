/**
 * The 17 fault tests of the porting guide rev 5.1 (section 7.3).
 *
 * This file is the catalogue. The harnesses that run the tests are in
 * definitions.ts (executor), actor/ and guest/. Rule: a test counts as passed only when it
 * ran with a real executor, a real guest helper and a real VM. A mock hides
 * the "ran but unreported" case. "One run" is read from a counter that the
 * command itself increments on the VM.
 */

export type FaultId = `D${number}`;

/** Where the test runs. "model" is the in-memory reference model. */
export type Backend = "model" | "node" | "guest-process" | "durable-objects" | "teenytiny-1node" | "teenytiny-2node" | "rivet";

/** The backends on which a pass counts as demonstrated. */
export const DEMONSTRATING_BACKENDS: ReadonlySet<Backend> = new Set([
  "durable-objects",
  "teenytiny-1node",
  "teenytiny-2node",
  "rivet",
]);

export type Status = "not_run" | "passing" | "failing";

export interface FaultCase {
  id: string;
  fault: string;
  expect: string;
}

export interface FaultTest {
  id: FaultId;
  /** Which part of the system the test is about. */
  area: "loop" | "inbox" | "executor" | "guest" | "store" | "wake";
  fault: string;
  expect: string;
  /** Sub-cases. The guide requires all of them (D9: 8, D11: 5, D14: 4). */
  cases?: FaultCase[];
  /** Guide sections that specify the mechanism. */
  sections: string[];
  /** Phase 0 tests run against the executor with upstream Hermes as the agent. */
  phase: 0 | 1;
}

export const FAULT_TESTS: readonly FaultTest[] = [
  {
    id: "D1",
    area: "loop",
    fault: "Shut the actor down during a model call: before, during, after the response",
    expect: "Rows consistent; pending_call completes or is unknown; no duplicate reply",
    sections: ["4.3", "6.3"],
    phase: 1,
  },
  {
    id: "D2",
    area: "executor",
    fault: "Shut the actor down after start(op_id) was sent to the executor",
    expect: "The new owner fences, adopts, and reads the result through status(op_id); the command ran once",
    sections: ["3.4"],
    phase: 0,
  },
  {
    id: "D3",
    area: "inbox",
    fault: "Deliver the same inbound message twice",
    expect: "One admission row; one turn",
    sections: ["2.4", "4.6"],
    phase: 1,
  },
  {
    id: "D4",
    area: "executor",
    fault: "Drop the executor's reply",
    expect: "The next status(op_id) returns the kept result; no second run",
    sections: ["3.4"],
    phase: 0,
  },
  {
    id: "D5",
    area: "executor",
    fault: "User sends /stop while a tool runs",
    expect: "Turn ends; cancel(op_id) is sent; the late result is accepted and discarded",
    sections: ["3.4"],
    phase: 0,
  },
  {
    id: "D6",
    area: "store",
    fault: "Two actors believe they own one session key",
    expect: "The lower epoch is rejected by the store and by the executor's fence",
    sections: ["4.6"],
    phase: 1,
  },
  {
    id: "D7",
    area: "store",
    fault: "Shut down between writing the child session and marking parent rows active=0",
    expect: "Lineage repaired; no row is active in both parent and child",
    sections: ["6.4"],
    phase: 1,
  },
  {
    id: "D8",
    area: "wake",
    fault: "A wake obligation fires twice for one cron job",
    expect: "The job runs once; the second firing is a no-op",
    sections: ["4.6"],
    phase: 1,
  },
  {
    id: "D9",
    area: "wake",
    fault: "Crashes around arming, committing and handling a wake obligation",
    expect: "No pending row is left without a timer or a sweeper record",
    sections: ["4.6"],
    phase: 1,
    cases: [
      { id: "a", fault: "Crash after the timer is armed and before the row commits", expect: "The wake is a no-op" },
      { id: "b", fault: "Crash after the row commits, then no further event", expect: "The wake alone brings the actor back; the turn continues or ends with a visible error" },
      { id: "c", fault: "The arm call fails", expect: "Nothing commits and the admission is tried again" },
      { id: "d", fault: "Crash inside the handler after it re-armed and before it did the work", expect: "The wake alone brings the actor back" },
      { id: "e", fault: "A test hook deletes the timer", expect: "The sweeper wakes the session from its synchronous open record" },
      { id: "f", fault: "Crash inside the handler before its re-arm completes", expect: "The sweeper wakes the session, with no outbox delivery" },
      { id: "g", fault: "Crash after the commit and before the outbox is delivered, and delete the timer", expect: "The sweeper wakes the session, with no outbox delivery" },
      { id: "h", fault: "Make the timer fire before the pending row commits", expect: "The handler finds no due obligation, sees the open turn, and re-arms" },
    ],
  },
  {
    id: "D10",
    area: "executor",
    fault: "Crash after the network send of start(op_id) and before anything is recorded",
    expect: "The retry reuses the same op_id; the executor returns duplicate; one run",
    sections: ["3.4"],
    phase: 0,
  },
  {
    id: "D11",
    area: "executor",
    fault: "Delayed duplicates across acknowledgement, restore and image replacement",
    expect: "The copy is refused; nothing runs",
    sections: ["3.4"],
    phase: 0,
    cases: [
      { id: "a", fault: "Send a copy of start(op_id) after the result was acknowledged, same incarnation", expect: "duplicate(done) from the tombstone; nothing runs" },
      { id: "b", fault: "Restore an older save, then deliver a delayed copy of an operation from before the restore", expect: "New incarnation through the lifecycle rule; the copy is expired" },
      { id: "c", fault: "As (b), with a save whose journal sequence equals the highest the cell has seen", expect: "New incarnation whatever the journal sequence says; the copy is expired" },
      { id: "d", fault: "replace_image, which keeps the data disk and its journal, then deliver a delayed copy", expect: "New incarnation; the copy is expired" },
      { id: "e", fault: "As (b), with the restore sent by an operator directly, not through the executor", expect: "New incarnation; the copy is expired" },
    ],
  },
  {
    id: "D12",
    area: "store",
    fault: "Crash after a session commit and before the profile index update",
    expect: "The outbox row survives; the index catches up; session_search finds the text",
    sections: ["4.6", "6.4"],
    phase: 1,
  },
  {
    id: "D13",
    area: "executor",
    fault: "Let an old owner's command keep running while a new owner takes over",
    expect: "The new owner's fence returns the operation; the new owner settles it before its own start; an old-epoch start is stale_epoch",
    sections: ["3.4"],
    phase: 0,
  },
  {
    id: "D14",
    area: "guest",
    fault: "Crashes around the launch",
    expect: "One run at most; unknown where the launch cannot be established",
    sections: ["3.4"],
    phase: 0,
    cases: [
      { id: "a", fault: "Crash the helper after launching and before it submits the unit", expect: "not_launched; the cell launches again; one run" },
      { id: "b", fault: "Crash it after the unit started and before the shim created the claim, and hold the shim there", expect: "starting; the helper adopts and waits; no second launch; one run" },
      { id: "c", fault: "Delay an earlier unit start in systemd, let the cell launch again, then release the earlier start", expect: "The two shims race for one claim; one run; the loser runs nothing" },
      { id: "d", fault: "Crash after the claim, then remove the evidence of the end", expect: "unknown; nothing launches again" },
    ],
  },
  {
    id: "D15",
    area: "guest",
    fault: "Crash the guest helper after the command started and before the helper answered",
    expect: "Reconciliation finds the cgroup and adopts it; the retried request returns running or the result; one run",
    sections: ["3.4"],
    phase: 0,
  },
  {
    id: "D16",
    area: "executor",
    fault: "Kill the executor cell's owner node while an operation is dispatching",
    expect: "The new owner asks the helper; the operation is resolved from the journal; one run",
    sections: ["3.4"],
    phase: 0,
  },
  {
    id: "D17",
    area: "executor",
    fault: "Owner 7 prepares an operation and crashes before start; owner 8 takes over",
    expect: "Owner 8's fence returns the prepared operation; start(op_id, 8) runs it once; a late call from owner 7 is stale_epoch",
    sections: ["3.4", "4.6"],
    phase: 0,
  },
];

/** The fault tests that phase 0 (the executor, milestone 1 step 2) must pass. */
export const PHASE0_FAULT_IDS: readonly FaultId[] = FAULT_TESTS.filter((t) => t.phase === 0).map((t) => t.id);
