import assert from "node:assert/strict";
import { it } from "node:test";
import type { JobFn } from "@hermesd/runtime";
import { eachNode } from "./test-util.ts";
import { createWorld } from "./world.ts";

// Host timers of closed obligations are removed, also across a crash, and never one an open obligation needs.

const jobs: Record<string, JobFn> = { nightly: () => {} };

eachNode(
  "a timer borrowed by a new obligation",
  (use) => {
    it(
      "is not lost when the obligation that owned it closes before the new one commits",
      use(async (b) => {
        const w = createWorld(b, { jobs, cron: false });
        await w.warm();
        const t0 = b.clock.now();
        await b.call("s1", "schedule_job", { job: "nightly", dueAt: t0 + w.config.minDelayMs });
        // The second job borrows the first one's timer. Between its arm and its commit, the first runs and closes.
        b.onPoint({ actor: "s1", point: "arm:after", event: "call", method: "schedule_job" }, async () => {
          void b.clock.advance(w.config.minDelayMs + 1);
          for (let i = 0; i < 200 && w.rows("s1", "rt_disarm").length + w.rows("s1", "job_runs").length < 1; i++) {
            await new Promise((r) => setImmediate(r));
          }
          for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); // let its cleanup finish
        });
        const due = t0 + 10 * w.config.minDelayMs;
        await b.call("s1", "schedule_job", { job: "nightly", dueAt: due });
        await b.settle();
        assert.equal(w.rows("s1", "job_runs").length, 1, "the first job ran");
        assert.equal(b.alarmOf("s1")?.at, due, "the second job has a timer");
      }),
    );
  },
  // On Durable Objects the input gate keeps the alarm out while the arm is in flight.
  [{ mode: "rivet" }],
);

eachNode("a crash after an obligation closed and before its timer was removed", (use) => {
  it(
    "the next activation removes the timer",
    use(async (b) => {
      const w = createWorld(b, { jobs, cron: false });
      await w.warm();
      await b.call("s1", "schedule_job", { job: "nightly", dueAt: b.clock.now() + w.config.minDelayMs });
      b.crashAt({ actor: "s1", point: "disarm:before" });
      await b.clock.advance(w.config.minDelayMs + 1);
      await b.settle();
      assert.equal(w.rows("s1", "job_runs").length, 1);
      assert.equal(w.rows("s1", "rt_disarm").length, 1, "the timer to remove is a row");
      await b.call("s1", "flush_outbox", {}); // any call activates the actor
      await b.settle();
      assert.deepEqual(w.rows("s1", "rt_disarm"), []);
      assert.equal(b.alarmOf("s1"), null);
    }),
  );
});
