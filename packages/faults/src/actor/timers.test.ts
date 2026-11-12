import assert from "node:assert/strict";
import { it } from "node:test";
import type { JobFn } from "@hermesd/runtime";
import { eachNode } from "./test-util.ts";
import { createWorld } from "./world.ts";

// Host timers of closed obligations are removed, also across a crash. The races with an arm in
// flight are in packages/runtime/src/timers.test.ts: this simulator runs one event at a time.

const jobs: Record<string, JobFn> = { nightly: () => {} };

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
      assert.ok(w.rows("s1", "rt_timers").length >= 1, "the timer to remove is a row");
      await b.call("s1", "flush_outbox", {}); // any call activates the actor
      await b.settle();
      assert.deepEqual(w.rows("s1", "rt_timers"), []);
      assert.equal(b.alarmOf("s1"), null);
    }),
  );
});
