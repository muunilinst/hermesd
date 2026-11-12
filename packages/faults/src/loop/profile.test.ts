import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";
import { type LoopWorld } from "./world.ts";

// The profile actor fed by the outbox of the real session actor (guide 6.4):
// the search index, the session list, idempotent apply, and reconcile.

type Hit = { session: string; seq: number; role: string; text: string };
const search = async (w: LoopWorld, q: string): Promise<Hit[]> => (await w.b.call("profile", "session_search", { query: q })) as Hit[];

eachLoopWorld("profile actor fed by the session outbox", (use) => {
  it(
    "indexes the messages and lists the session",
    use({ script: [{ reply: "the haystack has a needle" }] }, async (w) => {
      await w.send("find the needle please");
      await w.until(() => w.replies.length === 1, "the reply");
      await w.until(() => w.rows("outbox").length === 0, "the outbox is empty");
      const hits = await search(w, "needle");
      assert.deepEqual(
        hits.map((h) => [h.role, h.session]),
        [
          ["user", "s1"],
          ["assistant", "s1"],
        ],
      );
      assert.deepEqual(await search(w, "needle haystack"), [hits[1]], "words are joined with AND");
      const list = (await w.b.call("profile", "list_sessions")) as Array<{ sessionId: string; status: string; messageCount: number }>;
      assert.deepEqual(list.map((s) => [s.sessionId, s.status, s.messageCount]), [["s1", "done", 2]]);
    }),
  );

  it(
    "applies each outbox row once, also when it is sent twice",
    use({ script: [{ reply: "needle again" }] }, async (w) => {
      w.b.crashAt({ actor: "s1", point: "sidecar:after", detail: "actor:profile.index" });
      await w.send("one needle");
      await w.until(() => (w.b.query("profile", "SELECT 1 FROM search_docs").length > 0), "the first index call");
      await w.b.settle(); // the session crashed after the profile applied the row
      await w.wakeAll(); // the wake obligation brings the turn back
      await w.until(() => w.replies.length === 1, "the reply");
      await w.b.settle();
      await w.b.call("s1", "flush_outbox", {});
      await w.b.settle();
      assert.equal((await search(w, "needle")).length, 2, "two messages, each indexed once");
    }),
  );

  it(
    "D12 with the real session: a crash before the index update; the profile reconciles on activation",
    use({ script: [{ reply: "plain answer" }] }, async (w) => {
      w.b.crashAt({ actor: "s1", point: "sidecar:before", detail: "actor:profile.index" });
      await w.send("remember the needle");
      await w.until(() => w.rows("messages", "role = 'assistant'").length === 1, "the commit");
      await w.b.settle();
      assert.deepEqual(await search(w, "needle"), [], "the index has not heard of it yet");
      assert.equal(w.rows("outbox").length >= 1, true, "the outbox row survived");
      w.b.crash("profile");
      await search(w, "needle"); // the call activates the profile actor, which reconciles
      await w.b.settle();
      assert.equal((await search(w, "needle")).length, 1);
      assert.deepEqual(w.rows("outbox"), []);
    }),
  );

  it(
    "keeps working without FTS5: the LIKE scan gives the same answers",
    use({ script: [{ reply: "the haystack has a needle" }], forceLike: true }, async (w) => {
      await w.send("find the needle");
      await w.until(() => w.replies.length === 1, "the reply");
      await w.until(() => w.rows("outbox").length === 0, "the outbox is empty");
      assert.deepEqual(await w.b.call("profile", "status"), { fts: false });
      assert.equal((await search(w, "needle")).length, 2);
      assert.equal((await search(w, "100%_ ")).length, 0, "wildcards in the query are plain characters");
    }),
  );

  it(
    "uses FTS5 where the platform has it, and can rebuild the index",
    use({ script: [{ reply: "the haystack has a needle" }] }, async (w) => {
      await w.send("find the needle");
      await w.until(() => w.replies.length === 1, "the reply");
      await w.until(() => w.rows("outbox").length === 0, "the outbox is empty");
      const status = (await w.b.call("profile", "status")) as { fts: boolean };
      assert.equal(status.fts, true, "node:sqlite has FTS5");
      assert.deepEqual(await w.b.call("profile", "rebuild_index"), { rebuilt: 2 });
      assert.equal((await search(w, "needle")).length, 2);
    }),
  );

  it(
    "conversation_generations is monotonic and never collected",
    use({ script: [{ reply: "x" }] }, async (w) => {
      const bump = () => w.b.call("profile", "generation_bump", { source: "telegram", sessionKey: "chat-1" });
      assert.deepEqual(await bump(), { generation: 1 });
      assert.deepEqual(await bump(), { generation: 2 });
      await w.send("hi");
      await w.until(() => w.replies.length === 1, "the reply");
      w.b.crash("profile");
      assert.deepEqual(await w.b.call("profile", "generation_get", { source: "telegram", sessionKey: "chat-1" }), { generation: 2 });
      assert.deepEqual(await bump(), { generation: 3 });
      await assert.rejects(w.b.call("profile", "generation_delete", { source: "telegram", sessionKey: "chat-1" }), /unknown method/);
    }),
  );
});
