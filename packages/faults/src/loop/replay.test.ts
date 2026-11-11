import assert from "node:assert/strict";
import { it } from "node:test";
import { MODELS, ScriptedModel, createModelClient, type ApiMode, type ScriptStep } from "@hermesd/providers";
import { eachLoopWorld } from "./test-util.ts";
import { scriptedTerminal, type LoopWorld, type LoopWorldOptions } from "./world.ts";

// Provider reasoning and replay data (guide 6.3). The assistant row keeps what
// the provider needs to see again in the next tool round: signed Anthropic
// thinking blocks in `reasoning_details`, Responses reasoning items in
// `codex_reasoning_items`. The next request is rebuilt from the stored rows, so
// a restart between the rounds loses nothing.

const THINKING = { thinking: "The build needs the terminal first.", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds/e+SIGNATURE==" };
const CODEX_ITEM = { type: "reasoning", id: "rs_0001", summary: [{ type: "summary_text", text: "Plan the build" }], encrypted_content: "gAAAAABencrypted-blob-0001==" };

const cmd = JSON.stringify({ hold: "h1", stdout: "built" });

function opts(mode: ApiMode, script: ScriptStep[], stream = false): LoopWorldOptions {
  const model = new ScriptedModel(mode, script, { stream });
  return {
    script: [],
    provider: { client: createModelClient(mode, { model: MODELS[mode], stream }), model },
    loop: { ...scriptedTerminal, model: MODELS[mode] },
  };
}

/** Run round one up to the pending command, restart the actor if asked, finish the turn. */
async function twoRounds(w: LoopWorld, restart: boolean): Promise<void> {
  await w.send("build it");
  await w.until(() => w.rows("pending_op").length > 0, "the pending terminal op");
  if (restart) {
    w.b.crash("s1");
    await w.b.settle();
  }
  w.rig.commands.release("h1");
  await w.rig.settle();
  await w.wakeAll();
  await w.until(() => w.replies.length === 1, "the reply");
  // After a restart the second call may go out twice, with the same call id and the same bytes.
  const reqs = w.provider!.requests;
  assert.equal(new Set(reqs.map((r) => r.callId)).size, 2);
  const second = reqs.filter((r) => r.callId === reqs.at(-1)!.callId);
  for (const r of second) assert.deepEqual(r.body, second[0]!.body);
}

const secondBody = (w: LoopWorld): Record<string, any> => w.provider!.requests.at(-1)!.body as Record<string, any>;

eachLoopWorld("provider replay data survives the tool round", (use) => {
  for (const restart of [false, true]) {
    for (const stream of [false, true]) {
      const label = `${restart ? "after a restart" : "in memory"}, ${stream ? "streamed" : "plain"}`;
      it(
        `anthropic_messages ${label}: the signed thinking block is sent again, byte for byte`,
        use(
          () => opts("anthropic_messages", [{ thinking: [THINKING], reply: "I will build it", toolCalls: [{ name: "terminal", arguments: { command: cmd }, id: "toolu_a" }] }, { reply: "it is built" }], stream),
          async (w) => {
            await twoRounds(w, restart);
            // Stored in upstream's column.
            const row = w.rows("messages", "role = 'assistant'")[0]!;
            const details = JSON.parse(String(row.reasoning_details)) as unknown[];
            assert.deepEqual(details, [{ type: "thinking", thinking: THINKING.thinking, signature: THINKING.signature }]);
            assert.equal(row.reasoning, THINKING.thinking);
            // Replayed in the next request.
            const assistant = (secondBody(w).messages as Array<{ role: string; content: unknown[] }>).find((m) => m.role === "assistant")!;
            const block = assistant.content[0];
            assert.equal(JSON.stringify(block), JSON.stringify({ type: "thinking", thinking: THINKING.thinking, signature: THINKING.signature }));
            assert.deepEqual(assistant.content.map((b) => (b as { type: string }).type), ["thinking", "text", "tool_use"]);
            w.assertConsistent();
          },
        ),
      );
    }

    it(
      `codex_responses ${restart ? "after a restart" : "in memory"}: the reasoning item is sent again with its encrypted content`,
      use(
        () => opts("codex_responses", [{ reasoningItems: [CODEX_ITEM], reply: "I will build it", toolCalls: [{ name: "terminal", arguments: { command: cmd }, id: "call_a" }] }, { reply: "it is built" }]),
        async (w) => {
          await twoRounds(w, restart);
          const row = w.rows("messages", "role = 'assistant'")[0]!;
          // The adapter stamps the model that sealed the blob (`_issuer_model`); the rest is as received.
          assert.deepEqual(JSON.parse(String(row.codex_reasoning_items)), [{ ...CODEX_ITEM, _issuer_model: MODELS.codex_responses }]);
          const input = secondBody(w).input as Array<Record<string, unknown>>;
          const item = input.find((i) => i.type === "reasoning");
          assert.ok(item, "the request has the reasoning item");
          assert.equal(item.encrypted_content, CODEX_ITEM.encrypted_content);
          assert.deepEqual(item.summary, CODEX_ITEM.summary);
          // The reasoning item comes before the call that it led to.
          const at = (t: string) => input.findIndex((i) => i.type === t);
          assert.equal(at("reasoning") < at("function_call"), true);
          w.assertConsistent();
        },
      ),
    );
  }

  it(
    "a round with no reasoning stores nothing in the reasoning columns",
    use(
      () => opts("anthropic_messages", [{ reply: "plain answer" }]),
      async (w) => {
        await w.send("hi");
        await w.until(() => w.replies.length === 1, "the reply");
        const row = w.rows("messages", "role = 'assistant'")[0]!;
        for (const c of ["reasoning", "reasoning_content", "reasoning_details", "codex_reasoning_items", "codex_message_items"]) assert.equal(row[c], null, c);
      },
    ),
  );
});

eachLoopWorld("reasoning on the default chat_completions path", (use) => {
  it(
    "the row keeps reasoning_content and the next request sends it back",
    use(
      {
        script: [
          { reasoning: { reasoning_content: "Run the build first." }, toolCalls: [{ name: "terminal", arguments: { command: cmd }, id: "call_a" }] },
          { reply: "it is built" },
        ],
        loop: scriptedTerminal,
      },
      async (w) => {
        await w.send("build it");
        await w.until(() => w.rows("pending_op").length > 0, "the pending terminal op");
        w.rig.commands.release("h1");
        await w.rig.settle();
        await w.wakeAll();
        await w.until(() => w.replies.length === 1, "the reply");
        const row = w.rows("messages", "role = 'assistant'")[0]!;
        assert.equal(row.reasoning, "Run the build first.");
        const body = w.model.recorder.requests.at(-1)!.body as { messages: Array<Record<string, unknown>> };
        const asst = body.messages.find((m) => m.role === "assistant")!;
        assert.equal(asst.reasoning_content, "Run the build first.");
        assert.equal("reasoning" in asst, false, "the internal key is not sent");
      },
    ),
  );
});
