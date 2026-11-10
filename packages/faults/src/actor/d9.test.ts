import assert from "node:assert/strict";
import { it } from "node:test";
import type { ActorBackend } from "./backend.ts";
import { eachNode, never } from "./test-util.ts";
import { createWorld, type World } from "./world.ts";

// D9: crashes around arming, committing and handling a wake obligation (guide 4.6, 7.3).
// Cases (a) to (h). Rule: no pending row is left without a timer or a sweeper record.

/** Make a turn that crashed after its pending row committed and before the send. This is the start state of (b), (d), (e), (f). */
async function crashAfterPendingRow(b: ActorBackend, w: World): Promise<void> {
  w.driver.afterPend = async () => {
    b.crash("s1");
    return never();
  };
  await w.receive("s1", "req-1").catch(() => {});
  await b.settle();
  w.driver.afterPend = undefined;
}

const sentIds = (w: World): string[] => w.driver.sent.map((s) => s.callId);
const status = (w: World): unknown => w.rows("s1", "session_admissions")[0]?.status;

eachNode("D9 (a) crash after the timer is armed and before the row commits", (use) => {
  it(
    "the wake is a no-op and nothing is lost",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      b.crashAt({ actor: "s1", point: "arm:after", event: "call", method: "receive" });
      await w.receive("s1", "req-1").catch(() => {});
      await b.settle();
      // A timer with no work.
      assert.ok(b.alarmOf("s1"), "the timer is durable");
      assert.deepEqual(w.rows("s1", "turns"), []);
      assert.deepEqual(w.rows("s1", "wake_obligations"), []);
      assert.equal(status(w), "queued", "the admission is still in the inbox");
      assert.equal(w.driver.sent.length, 0);

      await b.clock.advance(w.config.minDelayMs + 1);
      await b.settle();
      // The wake found no obligation and no open turn. The inbox drain then started the turn once.
      assert.equal(w.rows("s1", "turns").length, 1);
      assert.equal(w.driver.sent.length, 1);
      assert.equal(status(w), "done");
    }),
  );
});

eachNode("D9 (b) crash after the row commits, then no further event", (use) => {
  it(
    "the wake alone brings the actor back and the turn continues",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await crashAfterPendingRow(b, w);
      assert.equal(w.driver.sent.length, 0);
      assert.equal(w.rows("s1", "pending_rows")[0]!.status, "pending");
      assert.ok(b.alarmOf("s1"), "a timer is armed for the open obligation");

      await b.clock.advance(w.config.minDelayMs + 1); // no other event
      await b.settle();
      assert.deepEqual(sentIds(w), ["turn-1:call-1"]);
      assert.equal(status(w), "done");
      assert.equal(w.rows("s1", "wake_obligations").filter((r) => r.state === "open").length, 0);
    }),
  );

  it(
    "or the turn ends with a visible error after the retries",
    use(async (b) => {
      const w = createWorld(b);
      w.driver.answers = false;
      await w.warm();
      await crashAfterPendingRow(b, w);
      for (let i = 0; i < 6; i++) {
        await b.clock.advance(w.config.minDelayMs + 1);
        await b.settle();
      }
      assert.equal(status(w), "failed");
      assert.match(String(w.rows("s1", "session_admissions")[0]!.result), /^error:/);
      // The same call ID each time. The retry is counted.
      assert.deepEqual([...new Set(sentIds(w))], ["turn-1:call-1"]);
      assert.equal(w.driver.sent.length, 3);
    }),
  );
});

eachNode("D9 (c) the arm call fails", (use) => {
  it(
    "nothing commits and the admission stays queued, then a sweep tries again",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      b.failArm("s1");
      await w.receive("s1", "req-1");
      await b.settle();
      assert.deepEqual(w.rows("s1", "turns"), []);
      assert.deepEqual(w.rows("s1", "wake_obligations"), []);
      assert.equal(status(w), "queued");
      assert.equal(b.alarmOf("s1"), null);
      assert.equal(w.driver.sent.length, 0);

      // No timer exists. The sweeper's slower cycle wakes every registered session.
      await b.clock.advance(10 * 60_000 + 1);
      await b.settle();
      assert.equal(status(w), "done");
      assert.equal(w.rows("s1", "turns").length, 1);
      assert.equal(w.driver.sent.length, 1);
    }),
  );

  it(
    "or the sender retries the same message: it is a duplicate and the turn starts",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      b.failArm("s1");
      await w.receive("s1", "req-1");
      await b.settle();
      assert.equal(status(w), "queued");
      const again = (await w.receive("s1", "req-1")) as { duplicate: boolean };
      await b.settle();
      assert.equal(again.duplicate, true);
      assert.equal(status(w), "done");
      assert.equal(w.rows("s1", "session_admissions").length, 1);
      assert.equal(w.driver.sent.length, 1);
    }),
  );
});

eachNode("D9 (d) crash inside the handler after it re-armed and before it did the work", (use) => {
  it(
    "the wake alone brings the actor back",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await crashAfterPendingRow(b, w);
      b.crashAt({ actor: "s1", point: "arm:after", event: "alarm" });
      await b.clock.advance(w.config.minDelayMs + 1);
      await b.settle();
      assert.equal(w.driver.sent.length, 0, "the handler crashed before the work");
      const next = b.alarmOf("s1");
      assert.ok(next, "the re-arm was durable before the crash");
      assert.ok(next.at > b.clock.now());

      await b.clock.advance(w.config.minDelayMs + 1);
      await b.settle();
      assert.deepEqual(sentIds(w), ["turn-1:call-1"]);
      assert.equal(status(w), "done");
    }),
  );
});

eachNode("D9 (e) a test hook deletes the timer", (use) => {
  it(
    "the sweeper wakes the session from its synchronous open record",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await crashAfterPendingRow(b, w);
      b.deleteTimer("s1");
      assert.equal(b.alarmOf("s1"), null);
      // The sweeper holds the open record from the start of the turn.
      assert.equal(w.rows("sweeper", "open_turns").length, 1);
      let sweeperWakes = 0;
      b.onPoint({ actor: "s1", point: "reply:before", event: "call", method: "wake" }, () => {
        sweeperWakes += 1;
      });

      await b.clock.advance(5 * 60_000);
      await b.settle();
      assert.equal(sweeperWakes >= 1, true, "the sweeper woke the session");
      assert.equal(status(w), "done");
      assert.deepEqual(sentIds(w), ["turn-1:call-1"]);
      assert.deepEqual(w.rows("sweeper", "open_turns"), [], "the close arrived through the outbox");
    }),
  );
});

// In (f) the failed run must not be retried by the platform, as on Rivet. Both modes run it
// with the retry switched off, so that only the sweeper can bring the session back.
eachNode(
  "D9 (f) crash inside the handler before its re-arm completes",
  (use) => {
    it(
      "the sweeper wakes the session, with no outbox delivery",
      use(async (b) => {
        const w = createWorld(b);
        await w.warm();
        await crashAfterPendingRow(b, w);
        b.crashAt({ actor: "s1", point: "arm:before", event: "alarm" });
        await b.clock.advance(w.config.minDelayMs + 1);
        await b.settle();
        assert.equal(w.driver.sent.length, 0);
        assert.equal(b.alarmOf("s1"), null, "the failed run was not retried and nothing is armed");
        assert.equal(w.rows("s1", "wake_obligations").filter((r) => r.state === "open").length >= 1, true);

        let sweeperWakes = 0;
        b.onPoint({ actor: "s1", point: "reply:before", event: "call", method: "wake" }, () => {
          sweeperWakes += 1;
        });
        await b.clock.advance(5 * 60_000);
        await b.settle();
        assert.equal(sweeperWakes >= 1, true);
        assert.equal(status(w), "done");
        assert.deepEqual(sentIds(w), ["turn-1:call-1"]);
      }),
    );
  },
  [
    { mode: "durable-objects", retryFailedAlarms: false },
    { mode: "rivet", retryFailedAlarms: false },
  ],
);

eachNode("D9 (g) crash after the commit and before the outbox is delivered, and delete the timer", (use) => {
  it(
    "the sweeper wakes the session, with no outbox delivery",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      b.crashAt({ actor: "s1", point: "sidecar:before", detail: "actor:sweeper.close" });
      await w.receive("s1", "req-1").catch(() => {});
      await b.settle();
      b.deleteTimer("s1");
      // The turn ended and committed. Its close never reached the sweeper.
      assert.equal(status(w), "done");
      assert.equal(w.rows("s1", "outbox").filter((r) => r.method === "close").length, 1);
      assert.equal(w.rows("sweeper", "open_turns").length, 1);
      assert.equal(b.alarmOf("s1"), null);
      let sweeperWakes = 0;
      b.onPoint({ actor: "s1", point: "reply:before", event: "call", method: "wake" }, () => {
        sweeperWakes += 1;
      });

      await b.clock.advance(5 * 60_000);
      await b.settle();
      assert.equal(sweeperWakes >= 1, true, "the sweeper woke the session on its own tick");
      assert.deepEqual(w.rows("sweeper", "open_turns"), []);
      assert.deepEqual(w.rows("s1", "outbox"), []);
      assert.equal(w.driver.sent.length, 1, "the wake started no second turn");
    }),
  );
});

eachNode("D9 (h) the timer fires before the pending row commits", (use) => {
  it(
    "the handler finds no due obligation, sees the open turn, and re-arms",
    use(async (b) => {
      const w = createWorld(b);
      w.driver.answers = false;
      await w.warm();
      let handlerRearms = 0;
      b.onPoint({ actor: "s1", point: "arm:after", event: "alarm" }, () => {
        handlerRearms += 1;
      });
      // The second arm of the receive chain is the arm for the pending row (the first is the turn's).
      b.onPoint({ actor: "s1", point: "arm:after", event: "call", method: "receive", nth: 2 }, async () => {
        const fired = b.fireTimerEarly("s1");
        // With an input gate the handler waits for the commit, so the hook must not wait for it.
        if (b.interleave === "every-await") await fired;
        else void fired.catch(() => {});
      });
      await w.receive("s1", "req-1");
      await b.settle();

      assert.equal(handlerRearms, 1, "the early handler re-armed");
      assert.ok(b.alarmOf("s1"), "the open turn is not left without a timer");
      assert.equal(w.rows("s1", "pending_rows").length, 1, "the pending row committed after the early fire");
      assert.equal(w.driver.sent.length, 1);
      // Nothing was due, so the early handler did not run the turn again.
      assert.equal(w.driver.starts, 1);

      // The timer still brings the session back.
      await b.clock.advance(w.config.minDelayMs + 1);
      await b.settle();
      assert.equal(w.driver.sent.length, 2, "the real wake re-drove the pending call with the same ID");
      assert.deepEqual([...new Set(sentIds(w))], ["turn-1:call-1"]);
    }),
  );

  it(
    "with no obligation at all and an open turn, the handler adds one that is due one minimum delay later",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await crashAfterPendingRow(b, w);
      b.query("s1", "DELETE FROM wake_obligations"); // the state that the rule guards against
      b.deleteTimer("s1");
      await b.fireTimerEarly("s1");
      await b.settle();
      const open = w.rows("s1", "wake_obligations").filter((r) => r.state === "open");
      assert.equal(open.length, 1);
      assert.equal(open[0]!.kind, "recheck");
      assert.equal(Number(open[0]!.due_at), b.clock.now() + w.config.minDelayMs);
      assert.ok(b.alarmOf("s1"));

      await b.clock.advance(w.config.minDelayMs + 1);
      await b.settle();
      assert.equal(status(w), "done");
    }),
  );
});
