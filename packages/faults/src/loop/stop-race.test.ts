import assert from "node:assert/strict";
import { it } from "node:test";
import { eachLoopWorld } from "./test-util.ts";

// /stop commits after the model answer was read but before the loop saved it. The stop
// said "stopped", so the answer must not go out: the turn ends with "Stopped." instead.

eachLoopWorld("a stop between reading and saving the answer", (use) => {
  it(
    "no reply after the stop succeeded",
    use({ script: [{ reply: "the answer" }] }, async (w) => {
      // The loop hashes the answer text right after reading it and before saving it. Stop there.
      const subtle = crypto.subtle;
      const digest = subtle.digest.bind(subtle);
      let stopped: unknown;
      const patched = async (alg: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
        if (stopped === undefined && new TextDecoder().decode(data as Uint8Array).includes("the answer")) stopped = await w.stop();
        return digest(alg, data);
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
      assert.equal(w.rows("messages", "role = 'assistant'").length, 0);
      w.assertConsistent();
    }),
  );
});
