import assert from "node:assert/strict";
import { it } from "node:test";
import { createWorld } from "./world.ts";
import { eachNode } from "./test-util.ts";
import { admissionState } from "./admission.ts";

// D3: deliver the same inbound message twice. One admission row; one turn.

eachNode("D3 duplicate inbound message", (use) => {
  it(
    "two deliveries one after the other make one admission and one turn",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      const first = (await w.receive("s1", "req-1", "hi")) as { admissionId: number; duplicate: boolean };
      const second = (await w.receive("s1", "req-1", "hi")) as { admissionId: number; duplicate: boolean };
      await b.settle();
      assert.equal(first.duplicate, false);
      assert.equal(second.duplicate, true);
      assert.equal(second.admissionId, first.admissionId);
      assert.equal(w.rows("s1", "session_admissions").length, 1);
      assert.equal(w.rows("s1", "turns").length, 1);
      assert.equal(w.driver.sent.length, 1);
      assert.equal(admissionState(w.rows("s1", "session_admissions")[0]!), "terminal:completed");
    }),
  );

  it(
    "two deliveries at the same time make one admission and one turn",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await Promise.all([w.receive("s1", "req-1"), w.receive("s1", "req-1")]);
      await b.settle();
      assert.equal(w.rows("s1", "session_admissions").length, 1);
      assert.equal(w.rows("s1", "turns").length, 1);
      assert.equal(w.driver.sent.length, 1);
    }),
  );

  it(
    "a late copy after the turn ended is still a duplicate and starts nothing",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await w.receive("s1", "req-1");
      await b.settle();
      const late = (await w.receive("s1", "req-1")) as { duplicate: boolean; status: string };
      await b.settle();
      assert.equal(late.duplicate, true);
      assert.equal(late.status, "terminal");
      assert.equal(w.rows("s1", "turns").length, 1);
      assert.equal(w.driver.sent.length, 1);
    }),
  );

  it(
    "a new request ID, or a new principal, is a new admission",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await w.receive("s1", "req-1");
      await w.receive("s1", "req-2");
      await w.receive("s1", "req-1", "hello", "user-2");
      await b.settle();
      assert.equal(w.rows("s1", "session_admissions").length, 3);
      assert.equal(w.rows("s1", "turns").length, 3);
    }),
  );

  it(
    "a later input waits while one admission is started",
    use(async (b) => {
      const w = createWorld(b);
      w.driver.answers = false; // the first turn stays open
      await w.warm();
      await w.receive("s1", "req-1");
      await w.receive("s1", "req-2");
      await b.settle();
      const statuses = w.rows("s1", "session_admissions").map(admissionState);
      assert.deepEqual(statuses, ["started", "queued"]);
      assert.equal(w.rows("s1", "turns").length, 1);
    }),
  );

  it(
    "a later input waits while one admission is unknown, and starts when the user resolves it",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await w.receive("s1", "req-1");
      await b.settle();
      // The owner was lost between steps: force the state that upstream calls "unknown".
      b.query("s1", "UPDATE session_admissions SET status = 'unknown' WHERE seq = 1");
      await w.receive("s1", "req-2");
      await b.settle();
      assert.deepEqual(
        w.rows("s1", "session_admissions").map(admissionState),
        ["unknown", "queued"],
      );
      b.query("s1", "UPDATE session_admissions SET status = 'terminal', outcome = 'interrupted' WHERE seq = 1");
      await b.call("s1", "wake", {});
      await b.settle();
      assert.deepEqual(
        w.rows("s1", "session_admissions").map(admissionState),
        ["terminal:interrupted", "terminal:completed"],
      );
    }),
  );
});
