import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";
import { scriptedTerminal, term } from "./world.ts";

// The loop's timers: a reply keeps its own retry, and a timer error after a commit is not a failed turn.

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

  it(
    "an arm that fails after the tool calls committed does not fail the turn",
    use(
      { script: [{ toolCalls: [term({ stdout: "built" })] }, { reply: "it is built" }], loop: scriptedTerminal },
      async (w) => {
        let answered = false;
        let failed = false;
        w.b.onPoint({ actor: "s1", point: "fetch:after" }, () => {
          answered = true;
        });
        // The first commit after the answer holds the tool calls. The arm after it fails.
        for (let nth = 1; nth <= 40; nth++) {
          w.b.onPoint({ actor: "s1", point: "commit:after", nth }, () => {
            if (!answered || failed) return;
            failed = true;
            w.b.failArm("s1", 1);
          });
        }
        await w.send("build it");
        await w.until(() => w.replies.length === 1, "the reply");
        assert.equal(failed, true);
        assert.equal(w.replies[0]!.text, "it is built");
        assert.equal(w.rows("messages", "role = 'tool'").length, 1, "the tool ran");
      },
    ),
  );
});
