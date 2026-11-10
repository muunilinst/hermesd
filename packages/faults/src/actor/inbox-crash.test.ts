import assert from "node:assert/strict";
import { it } from "node:test";
import { eachNode } from "./test-util.ts";
import { createWorld } from "./world.ts";

// Inbox crash: a crash between receive and the admission write loses nothing
// (guide 7.4, on Rivet; the rule holds on every host). An inbound message is a
// session_admissions row first and an event second.

eachNode("inbox crash between receive and admission write", (use) => {
  it(
    "a crash before the admission commits gives the sender no acknowledgement, and the retry is admitted once",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      b.crashAt({ actor: "s1", point: "tx:before", event: "call", method: "receive" });
      await assert.rejects(w.receive("s1", "req-1"), (e: Error) => e.name === "CrashError");
      await b.settle();
      assert.deepEqual(w.rows("s1", "session_admissions"), [], "nothing was written, nothing was acknowledged");

      // The sender did not get an answer, so it sends again.
      const again = (await w.receive("s1", "req-1")) as { duplicate: boolean };
      await b.settle();
      assert.equal(again.duplicate, false);
      assert.equal(w.rows("s1", "session_admissions").length, 1);
      assert.equal(w.rows("s1", "turns").length, 1);
      assert.equal(w.driver.sent.length, 1);
      assert.equal(w.rows("s1", "session_admissions")[0]!.status, "done");
    }),
  );

  it(
    "a crash after the admission commits and before the reply loses nothing, with or without a retry",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      b.crashAt({ actor: "s1", point: "reply:before", event: "call", method: "receive" });
      await assert.rejects(w.receive("s1", "req-1"), (e: Error) => e.name === "CrashError");
      await b.settle();
      assert.equal(w.rows("s1", "session_admissions").length, 1, "the row is durable");

      // No retry from the sender: the wake and the sweeper's slow cycle bring the work back.
      await b.clock.advance(10 * 60_000 + 1);
      await b.settle();
      assert.equal(w.rows("s1", "session_admissions").length, 1);
      assert.equal(w.rows("s1", "session_admissions")[0]!.status, "done");
      assert.equal(w.rows("s1", "turns").length, 1);
      assert.deepEqual([...new Set(w.driver.sent.map((s) => s.callId))], ["turn-1:call-1"]);
    }),
  );

  it(
    "a retry after that crash is a duplicate and starts no second turn",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      b.crashAt({ actor: "s1", point: "reply:before", event: "call", method: "receive" });
      await w.receive("s1", "req-1").catch(() => {});
      const again = (await w.receive("s1", "req-1")) as { duplicate: boolean };
      await b.clock.advance(10 * 60_000 + 1);
      await b.settle();
      assert.equal(again.duplicate, true);
      assert.equal(w.rows("s1", "session_admissions").length, 1);
      assert.equal(w.rows("s1", "turns").length, 1);
    }),
  );

  it(
    "a session that cannot reach the sweeper does not accept the message, so nothing is acknowledged and then lost",
    use(async (b) => {
      const w = createWorld(b);
      // No warm-up: the session is not registered yet. The sweeper is unreachable for the first try.
      b.crashAt({ actor: "sweeper", point: "tx:before", event: "call", method: "register" });
      await assert.rejects(w.receive("s1", "req-1"));
      await b.settle();
      assert.deepEqual(w.rows("s1", "session_admissions"), []);
      const ok = (await w.receive("s1", "req-1")) as { duplicate: boolean };
      await b.settle();
      assert.equal(ok.duplicate, false);
      assert.equal(w.rows("sweeper", "sessions").length, 1);
      assert.equal(w.rows("s1", "session_admissions")[0]!.status, "done");
    }),
  );
});
