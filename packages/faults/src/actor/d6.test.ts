import assert from "node:assert/strict";
import { it } from "node:test";
import { eachNode } from "./test-util.ts";
import { createWorld } from "./world.ts";

// D6 (store side): two actors believe they own one session key. The lower
// epoch is rejected by the store. The executor's fence is tested with the
// executor (D2, D13, D17), not here.

eachNode("D6 two owners of one session key", (use) => {
  it(
    "the store rejects a write from the older activation, and accepts the newer one",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await w.receive("s1", "req-1");
      await b.settle();

      const { old, fresh } = await b.splitBrain("s1");
      assert.ok(fresh.epoch > old.epoch, "the newer activation has the higher epoch");
      assert.equal(b.epochOf("s1"), fresh.epoch);

      const call = (req: string) => ({ principal: "user-1", session: "s1", request: req, input: "x" });
      await assert.rejects(old.call("receive", call("from-old")), (e: Error) => e.name === "StaleEpochError");
      await fresh.call("receive", call("from-new"));
      await b.settle();
      const requests = w.rows("s1", "session_admissions").map((r) => r.request);
      assert.deepEqual(requests, ["req-1", "from-new"]);
    }),
  );

  it(
    "the old activation also fails on append, wake and flush, and writes nothing",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      const { old } = await b.splitBrain("s1");
      await assert.rejects(old.call("append", { role: "user", text: "zombie" }), (e: Error) => e.name === "StaleEpochError");
      await assert.rejects(old.call("wake", {}), (e: Error) => e.name === "StaleEpochError");
      assert.deepEqual(w.rows("s1", "rt_messages"), []);
    }),
  );

  it(
    "receivers of the outbox and of the sweeper calls refuse a lower epoch",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await w.receive("s1", "req-1");
      await b.settle();
      // A second owner: the session crashes and starts again with a higher epoch.
      b.crash("s1");
      await w.receive("s1", "req-2");
      await b.settle();
      const epoch = b.epochOf("s1");
      assert.ok(epoch >= 2);

      const stale = { session: "s1", epoch: epoch - 1 };
      const isStale = (e: Error): boolean => e.name === "StaleEpochError";
      await assert.rejects(b.call("sweeper", "open", { ...stale, turn: "turn-x", horizon: 1 }), isStale);
      await assert.rejects(b.call("sweeper", "close", { ...stale, turn: "turn-1", idempotencyKey: "k" }), isStale);
      await assert.rejects(b.call("profile", "index", { ...stale, seq: 1, text: "old", idempotencyKey: "s1#99" }), isStale);
      assert.deepEqual(await b.call("profile", "session_search", { query: "old" }), []);
    }),
  );

  it(
    "the epoch rises at every activation, in the first committed transaction",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      const seen: number[] = [b.epochOf("s1")];
      for (let i = 0; i < 3; i++) {
        b.crash("s1");
        await b.call("s1", "tail");
        seen.push(b.epochOf("s1"));
      }
      assert.deepEqual(seen, [1, 2, 3, 4]);
    }),
  );
});
