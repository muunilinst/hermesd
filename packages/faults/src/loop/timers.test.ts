import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";

// The loop's timers: a reply keeps its own retry.

eachLoopWorld("loop timers", (use) => {
  it(
    "a reply whose delivery failed is retried soon, also when a distant job holds the next timer",
    use({ script: [{ reply: "hello there" }], cron: false, gatewayFailures: 1 }, async (w) => {
      await w.b.call("s1", "schedule_job", { job: "someday", dueAt: w.b.clock.now() + 86_400_000 });
      await w.send("hi");
      await w.until(() => w.deliveries === 1, "the failed delivery");
      await w.b.settle();
      await w.wakeAll();
      await w.until(() => w.replies.length === 1, "the retried reply");
      assert.equal(w.replies[0]!.text, "hello there");
    }),
  );
});
