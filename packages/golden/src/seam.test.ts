import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NODE_CONFIGS, createLoopWorld, scriptedTerminal, term, type LoopWorldOptions } from "@hermesd/faults";
import { MODELS, ScriptedModel, createModelClient, type ScriptStep } from "@hermesd/providers";
import type { LoopHooks } from "@hermesd/session-actor";

// The two seams that the golden scripts use, tested on their own: the pre_tool_call hook seam
// and the fallback target. The scripts show the main paths; these show the edges.

function options(steps: ScriptStep[], extra: Partial<LoopWorldOptions> = {}): LoopWorldOptions {
  const model = new ScriptedModel("chat_completions", steps);
  return {
    script: [],
    provider: { client: createModelClient("chat_completions", { model: MODELS.chat_completions }), model },
    loop: { ...scriptedTerminal, model: MODELS.chat_completions },
    ...extra,
  };
}

const ONE_CALL: ScriptStep[] = [{ toolCalls: [term({ stdout: "ran" }, "call_1")] }, { reply: "done" }];

for (const cfg of NODE_CONFIGS) {
  describe(`hook seam [node/${cfg.mode}]`, () => {
    const run = async (hooks: LoopHooks | undefined): Promise<{ tool: string; runs: number; calls: Array<Record<string, unknown>> }> => {
      const calls: Array<Record<string, unknown>> = [];
      const wrapped: LoopHooks | undefined = hooks && {
        preToolCall: (k) => {
          calls.push(k);
          return hooks.preToolCall(k);
        },
      };
      const w = await createLoopWorld(cfg, options(ONE_CALL, wrapped ? { hooks: wrapped } : {}));
      try {
        await w.send("go");
        await w.until(() => w.replies.length === 1, "the reply");
        return { tool: String(w.rows("messages", "role = 'tool'")[0]!.content), runs: w.rig.guest.totalRuns(), calls };
      } finally {
        w.b.close();
      }
    };

    it("approve lets the tool run, and the hook gets the upstream keyword arguments", async () => {
      const r = await run({ preToolCall: async () => ({ action: "approve" }) });
      assert.equal(r.runs, 1);
      assert.match(r.tool, /ran/);
      assert.equal(r.calls.length, 1);
      assert.deepEqual(Object.keys(r.calls[0]!).sort(), [
        "api_request_id", "args", "conversation_id", "middleware_trace", "session_id", "task_id", "tool_call_id", "tool_name", "turn_id",
      ]);
      assert.equal(r.calls[0]!.tool_name, "terminal");
      assert.equal(r.calls[0]!.tool_call_id, "call_1");
    });

    it("a dispatcher that throws does not block (upstream _pre_tool_block)", async () => {
      const r = await run({
        preToolCall: async () => {
          throw new Error("dispatcher broke");
        },
      });
      assert.equal(r.runs, 1);
    });

    it("a block runs no tool and the message is the result, as Python json.dumps writes it", async () => {
      const r = await run({ preToolCall: async () => ({ action: "block", message: "no — «stop»" }) });
      assert.equal(r.runs, 0);
      assert.equal(r.tool, '{"error": "no — «stop»"}');
    });
  });

  describe(`fallback target [node/${cfg.mode}]`, () => {
    it("stays on the fallback for the rest of the turn, and the next turn starts on the primary", async () => {
      // Turn 1: the primary gives 429 (step 0). The fallback answers with a tool call, then the final answer.
      // Turn 2: a new call id takes primary step 1, a plain answer.
      const primary = new ScriptedModel("chat_completions", [{ status: 429 }, { reply: "primary again" }]);
      const fallback = new ScriptedModel("chat_completions", [{ toolCalls: [term({ stdout: "ran" }, "call_1")] }, { reply: "fallback done" }]);
      const seen: string[] = [];
      const fetchAny = async (req: Request, signal?: AbortSignal): Promise<Response> => {
        const model = ((await req.clone().json()) as { model: string }).model;
        seen.push(model);
        return (model === "fallback-model" ? fallback : primary).fetch(req, signal);
      };
      const w = await createLoopWorld(cfg, {
        script: [],
        provider: {
          client: createModelClient("chat_completions", { model: "primary-model" }),
          model: { fetch: fetchAny, requests: [], aborted: 0, release: () => {} },
        },
        fallback: { client: createModelClient("chat_completions", { model: "fallback-model" }), model: "fallback-model" },
        loop: { ...scriptedTerminal, model: "primary-model" },
      });
      try {
        await w.send("one");
        await w.until(() => w.replies.length === 1, "the first reply");
        assert.deepEqual(seen, ["primary-model", "fallback-model", "fallback-model"]);
        assert.equal(w.replies[0]!.text, "fallback done");
        await w.send("two");
        await w.until(() => w.replies.length === 2, "the second reply");
        assert.equal(seen.at(-1), "primary-model");
        assert.equal(w.replies[1]!.text, "primary again");
        w.assertConsistent();
      } finally {
        w.b.close();
      }
    });
  });
}
