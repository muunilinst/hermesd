import assert from "node:assert/strict";
import { it } from "node:test";
import type { ActorBackend } from "./backend.ts";
import { eachNode } from "./test-util.ts";
import { createWorld, type World } from "./world.ts";

// D12: crash after a session commit and before the profile index update.
// The outbox row survives; the index catches up; session_search finds the text.

const search = async (b: ActorBackend, q: string): Promise<Array<{ session: string; seq: number; text: string }>> =>
  (await b.call("profile", "session_search", { query: q })) as Array<{ session: string; seq: number; text: string }>;

/** Commit a message and crash the session before the index update is sent. */
async function commitThenCrash(b: ActorBackend, w: World): Promise<void> {
  await b.call("profile", "register_session", { session: "s1" });
  b.crashAt({ actor: "s1", point: "sidecar:before", detail: "actor:profile.index" });
  await b.call("s1", "append", { role: "user", text: "remember the needle in the haystack" }).catch(() => {});
  await b.settle();
  assert.equal(w.rows("s1", "rt_messages").length, 1, "the session commit is durable");
  assert.equal(w.rows("s1", "outbox").length, 1, "the outbox row is in the same commit");
  assert.deepEqual(await search(b, "needle"), [], "the index has not heard of it");
}

eachNode("D12 crash between session commit and index update", (use) => {
  it(
    "the profile actor reconciles on activation and the index catches up",
    use(async (b) => {
      const w = createWorld(b, { cron: false });
      await w.warm();
      await commitThenCrash(b, w);
      assert.equal(b.epochOf("s1") >= 1, true);

      // The profile actor restarts. On activation it asks the session for its old outbox rows.
      b.crash("profile");
      await search(b, "needle"); // this call activates the profile actor
      await b.settle();
      const hits = await search(b, "needle");
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.session, "s1");
      assert.deepEqual(w.rows("s1", "outbox"), [], "the row is deleted after the receiver confirmed");
    }),
  );

  it(
    "the sweeper's slow cycle also wakes the session, which delivers its outbox",
    use(async (b) => {
      const w = createWorld(b);
      await w.warm();
      await commitThenCrash(b, w);
      await b.clock.advance(10 * 60_000 + 1);
      await b.settle();
      assert.equal((await search(b, "needle")).length, 1);
      assert.deepEqual(w.rows("s1", "outbox"), []);
    }),
  );

  it(
    "a row that was applied but not yet deleted is sent again and applied once",
    use(async (b) => {
      const w = createWorld(b, { cron: false });
      await w.warm();
      b.crashAt({ actor: "s1", point: "sidecar:after", detail: "actor:profile.index" });
      await b.call("s1", "append", { role: "user", text: "needle once" }).catch(() => {});
      await b.settle();
      assert.equal((await search(b, "needle")).length, 1, "the receiver applied it before the crash");
      assert.equal(w.rows("s1", "outbox").length, 1, "the session did not see the confirmation");

      await b.call("s1", "flush_outbox", {}); // the next activation sends the row again
      await b.settle();
      assert.equal((await search(b, "needle")).length, 1, "the receiver ignored the second copy");
      assert.deepEqual(w.rows("s1", "outbox"), []);
    }),
  );

  it(
    "a delivery that fails once is tried again later and the order is kept",
    use(async (b) => {
      const w = createWorld(b, { cron: false });
      await w.warm();
      // The first send fails: the hook throws once. The row stays in the outbox.
      b.onPoint({ actor: "s1", point: "sidecar:before", detail: "actor:profile.index" }, () => {
        throw new Error("profile unreachable");
      });
      await b.call("s1", "append", { role: "user", text: "first needle" });
      await b.call("s1", "append", { role: "user", text: "second needle" });
      await b.settle();
      await b.call("s1", "flush_outbox", {});
      await b.settle();
      assert.deepEqual(
        (await search(b, "needle")).map((h) => h.text),
        ["first needle", "second needle"],
      );
      assert.deepEqual(w.rows("s1", "outbox"), []);
    }),
  );
});
