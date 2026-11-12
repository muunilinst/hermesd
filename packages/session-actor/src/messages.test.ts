import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureSession, insertMessage, insertPortRow, loadActiveMessages, toApiMessage } from "./messages.ts";
import { DEFAULT_MIGRATIONS } from "./migrate.ts";
import { sessionDb } from "./testing.ts";

// Interleaved Anthropic blocks are kept with the call that returned them and put back on the
// assistant row. A row that compaction rewrote must not get them: they hold the old text.

const BLOCKS = [
  { type: "thinking", thinking: "Plan.", signature: "SIG==" },
  { type: "tool_use", id: "toolu_a", name: "terminal", input: {} },
  { type: "text", text: "original text" },
];

function seed(compressedSummary: boolean): ReturnType<typeof loadActiveMessages> {
  const { sql } = sessionDb();
  ensureSession(sql, { id: "s1", source: "teenytiny", model: "m", systemPrompt: "p", systemPromptHash: "h" }, 0);
  insertMessage(
    sql,
    "s1",
    {
      role: "assistant",
      content: compressedSummary ? "[summary] earlier work\n\noriginal text" : "original text",
      messageUid: "t1:c1:a",
      ...(compressedSummary ? { compressedSummary: true } : {}),
    },
    0,
  );
  insertPortRow(
    sql,
    DEFAULT_MIGRATIONS,
    "pending_call",
    { call_id: "t1:c1", turn_id: "t1", seq: 1, status: "done", request: "{}", created_at: 0, updated_at: 0 },
    { replay: { anthropic_content_blocks: BLOCKS } },
  );
  return loadActiveMessages(sql, "s1");
}

describe("ordered replay blocks", () => {
  it("come back on the assistant row of their call", () => {
    assert.deepEqual(toApiMessage(seed(false)[0]!).anthropic_content_blocks, BLOCKS);
  });

  it("are left off a row that compaction rewrote, so its new text is sent", () => {
    const m = toApiMessage(seed(true)[0]!);
    assert.equal(m.anthropic_content_blocks, undefined);
    assert.match(String(m.content), /\[summary\] earlier work/);
  });
});
