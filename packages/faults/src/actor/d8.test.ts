import assert from "node:assert/strict";
import { it } from "node:test";
import type { JobFn } from "@hermesd/runtime";
import type { ActorBackend } from "./backend.ts";
import { eachNode } from "./test-util.ts";
import { createWorld, type World } from "./world.ts";

// D8: a wake obligation fires twice for one cron job. The job runs once; the second firing is a no-op.

/** The job writes one message row. The row is the effect that the test counts. */
const jobs: Record<string, JobFn> = {
  nightly: (sql) => {
    sql.exec("INSERT INTO rt_messages (turn_id, role, text, created_at) VALUES (NULL, 'job', 'nightly ran', 0)");
  },
};

const effects = (w: World): number => w.rows("s1", "rt_messages", "role = 'job'").length;

async function scheduleNightly(b: ActorBackend, w: World): Promise<void> {
  await b.call("s1", "schedule_job", { job: "nightly", dueAt: b.clock.now() + w.config.minDelayMs });
}

eachNode("D8 a wake obligation fires twice", (use) => {
  it(
    "the job runs once when the timer fires and then fires again",
    use(async (b) => {
      const w = createWorld(b, { jobs, cron: false });
      await w.warm();
      await scheduleNightly(b, w);
      await b.clock.advance(w.config.minDelayMs + 1);
      await b.settle();
      assert.equal(effects(w), 1);
      // The platform delivers the same alarm again (at-least-once), twice more.
      await b.fireTimerEarly("s1");
      await b.fireTimerEarly("s1");
      await b.settle();
      assert.equal(effects(w), 1);
      assert.equal(w.rows("s1", "job_runs").length, 1);
      assert.equal(w.rows("s1", "wake_obligations").filter((r) => r.state === "open").length, 0);
    }),
  );

  it(
    "two firings at the same time run the job once",
    use(async (b) => {
      const w = createWorld(b, { jobs, cron: false });
      await w.warm();
      await scheduleNightly(b, w);
      await b.clock.advance(w.config.minDelayMs + 1);
      await b.settle();
      // Make the obligation due again by hand-free means: schedule a second job and fire both handlers together.
      await scheduleNightly(b, w);
      b.query("s1", "UPDATE wake_obligations SET due_at = 0 WHERE state = 'open'");
      await Promise.all([b.fireTimerEarly("s1"), b.fireTimerEarly("s1")]);
      await b.settle();
      assert.equal(effects(w), 2, "one effect per obligation, not per firing");
      assert.equal(w.rows("s1", "job_runs").length, 2);
    }),
  );

  it(
    "a crash before the job transaction commits runs the job once, after the retry",
    use(async (b) => {
      const w = createWorld(b, { jobs, cron: false });
      await w.warm();
      await scheduleNightly(b, w);
      // The 4th transaction of the handler is the job transaction (claim and effect). Crash before it commits.
      b.crashAt({ actor: "s1", point: "tx:before-commit", event: "alarm", nth: 4 });
      await b.clock.advance(w.config.minDelayMs + 1);
      await b.settle();
      assert.equal(effects(w), 0, "the effect rolled back with the claim");
      assert.equal(w.rows("s1", "wake_obligations").filter((r) => r.state === "open").length, 1);
      await b.clock.advance(w.config.minDelayMs + 1); // the handler re-armed first, so the retry comes by itself
      await b.settle();
      assert.equal(effects(w), 1);
      await b.fireTimerEarly("s1");
      await b.settle();
      assert.equal(effects(w), 1);
    }),
  );
});
