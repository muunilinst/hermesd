import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";
import { scriptedTerminal, term } from "./world.ts";

// /stop commits after the model answer was read but before the loop saved it. The stop
// said "stopped", so the answer must not go out: the turn ends with "Stopped." instead.

eachLoopWorld("a stop between reading and saving the answer", (use, cfg) => {
  it(
    "no reply after the stop succeeded",
    use({ script: [{ reply: "the answer" }] }, async (w) => {
      // The loop hashes the answer text right after reading it and before saving it. Stop there.
      const subtle = crypto.subtle;
      const digest = subtle.digest.bind(subtle);
      let stopped: unknown;
      const patched = async (...args: Parameters<typeof digest>): Promise<ArrayBuffer> => {
        if (stopped === undefined && new TextDecoder().decode(args[1] as Uint8Array).includes("the answer")) stopped = await w.stop();
        return digest(...args);
      };
      Object.defineProperty(subtle, "digest", { value: patched, configurable: true, writable: true });
      try {
        await w.send("go");
        await w.until(() => w.replies.length === 1, "a reply");
      } finally {
        Object.defineProperty(subtle, "digest", { value: digest, configurable: true, writable: true });
      }
      assert.deepEqual(stopped, { stopped: true, turn: (stopped as { turn: string }).turn });
      assert.deepEqual(w.replies.map((r) => r.text), ["Stopped."]);
      assert.equal(w.rows("messages", "role = 'assistant' AND display_kind IS NULL").length, 0, "no model row; only the failed-turn notice");
      w.assertConsistent();
    }),
  );

  // On Durable Objects the input gate keeps the stop out while the error's write is in flight,
  // and there is no await between the answer and that write: the window is Rivet's.
  if (cfg.mode !== "durable-objects") it(
    "no error reply after the stop succeeded",
    use({ script: [{ status: 400 }] }, async (w) => {
      // The failed answer is read; the stop commits before the loop writes the error.
      let stopped: unknown;
      let fetched = false;
      let stopping = false;
      w.b.onPoint({ actor: "s1", point: "fetch:after" }, () => {
        fetched = true;
      });
      // The first write after the answer came back is the error's step: stop just before it.
      for (let nth = 1; nth <= 40; nth++) {
        w.b.onPoint({ actor: "s1", point: "tx:before", nth }, async () => {
          if (!fetched || stopping) return;
          stopping = true;
          stopped = await w.stop();
        });
      }
      await w.send("go");
      await w.until(() => w.replies.length === 1, "a reply");
      assert.equal((stopped as { stopped?: boolean }).stopped, true);
      assert.deepEqual(w.replies.map((r) => r.text), ["Stopped."]);
      w.assertConsistent();
    }),
  );

  if (cfg.mode !== "durable-objects") it(
    "no unknown-outcome prompt after the stop succeeded",
    use({ script: [{ toolCalls: [term({ hold: "h1" })] }, { reply: "after" }], loop: scriptedTerminal }, async (w) => {
      await w.send("go");
      await w.until(() => w.link.sent.some((m) => m.method === "start"), "start was sent");
      await w.b.settle();
      // The VM restarts: the command has no exit status. The stop commits after the status read
      // that finds it unknown, and before the loop writes the question to the user.
      await w.rig.cell.stopVm();
      await w.rig.cell.startVm();
      let stopped: unknown;
      w.b.onPoint({ actor: "s1", point: "sidecar:after", detail: "executor.status" }, async () => {
        stopped = await w.stop();
      });
      await w.b.call("s1", "op_event", {});
      await w.until(() => w.replies.length === 1, "a reply");
      assert.equal((stopped as { stopped?: boolean }).stopped, true);
      assert.deepEqual(w.replies.map((r) => r.text), ["Stopped."]);
      assert.notEqual(w.rows("session_admissions")[0]!.status, "unknown", "later inputs are not blocked");
      w.assertConsistent();
    }),
  );
});
