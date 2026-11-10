import assert from "node:assert/strict";
import { it } from "node:test";
import type { Host } from "@hermesd/host";
import { eachNode } from "./test-util.ts";
import { createWorld } from "./world.ts";

// Rivet (guide 4.4, 7.4): "By default, actions run in parallel and interleave
// at every await, so two actions can both append to a session." Two parallel
// actions must not both append. The test runs on both rule sets, because the
// runtime must be safe without relying on the input gate.

eachNode("parallel actions on one session", (use, cfg) => {
  it(
    "two parallel appends with the same expected tail: one wins, one is refused",
    use(async (b) => {
      const w = createWorld(b, { cron: false });
      await w.warm();
      const [r1, r2] = (await Promise.all([
        b.call("s1", "append", { role: "user", text: "A", expectedTail: 0 }),
        b.call("s1", "append", { role: "user", text: "B", expectedTail: 0 }),
      ])) as Array<{ ok: boolean }>;
      assert.deepEqual([r1!.ok, r2!.ok].sort(), [false, true]);
      assert.equal(w.rows("s1", "rt_messages").length, 1);
    }),
  );

  it(
    "many parallel appends chain with unique, gap-free sequence numbers",
    use(async (b) => {
      const w = createWorld(b, { cron: false });
      await w.warm();
      await Promise.all(Array.from({ length: 8 }, (_, i) => b.call("s1", "append", { role: "user", text: `m${i}` })));
      assert.deepEqual(
        w.rows("s1", "rt_messages").map((r) => r.seq),
        [1, 2, 3, 4, 5, 6, 7, 8],
      );
    }),
  );

  it(
    "two parallel inbound actions write two admission rows and start one turn at a time",
    use(async (b) => {
      const w = createWorld(b);
      w.driver.answers = false; // the first turn stays open
      await w.warm();
      await Promise.all([w.receive("s1", "req-A", "A"), w.receive("s1", "req-B", "B")]);
      await b.settle();
      assert.equal(w.rows("s1", "session_admissions").length, 2);
      assert.deepEqual(
        w.rows("s1", "session_admissions").map((r) => r.status).sort(),
        ["queued", "started"],
      );
      assert.equal(w.rows("s1", "turns").length, 1, "the inbound actions never run a turn; one background task does");
    }),
  );

  it(
    "the platform really interleaves as the mode says (a naive read, await, write loses an update on Rivet only)",
    use(async (b) => {
      const naive = (host: Host) => ({
        async activate() {
          await host.tx((sql) => {
            sql.exec("CREATE TABLE IF NOT EXISTS n (v INTEGER)");
            sql.exec("INSERT INTO n VALUES (0)");
          });
          await host.commit();
        },
        async call() {
          const seen = await host.tx((sql) => Number(sql.exec("SELECT v FROM n")[0]!.v));
          await host.tx((sql) => sql.exec("SELECT 1")); // an await on storage
          await host.tx((sql) => sql.exec("UPDATE n SET v = ?", seen + 1));
          return null;
        },
      });
      b.defineActor("naive", naive);
      await b.call("naive", "warm");
      await Promise.all([b.call("naive", "go"), b.call("naive", "go")]);
      const v = Number(b.query("naive", "SELECT v FROM n")[0]!.v);
      // The warm call counts once. A safe run ends at 3. A lost update ends at 2.
      assert.equal(v, cfg.mode === "durable-objects" ? 3 : 2);
    }),
  );
});
