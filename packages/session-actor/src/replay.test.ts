import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toApiMessage, type NewMessage } from "./messages.ts";
import {
  FAILED_TURN_NOTICE,
  INTERRUPTED_COMMAND_RESULT,
  INTERRUPTED_PLACEHOLDER,
  PARTIAL_FAILED_TURN_NOTICE,
  failedTurnRow,
  interruptPlaceholderRow,
  isInterruptedToolResult,
  stripInterruptedToolTails,
} from "./replay.ts";

const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
const asst = (calls: ReturnType<typeof call>[]): NewMessage => ({ role: "assistant", content: null, toolCalls: calls, messageUid: "a" });
const tool = (id: string, name: string, content: string): NewMessage => ({ role: "tool", content, toolCallId: id, toolName: name, messageUid: `${id}:r` });
const user = (content: string): NewMessage => ({ role: "user", content, messageUid: content });

describe("interrupted tool results (replay_cleanup.py)", () => {
  it("knows the executor's interrupt shape and nothing else", () => {
    assert.equal(isInterruptedToolResult(INTERRUPTED_COMMAND_RESULT), true);
    assert.equal(isInterruptedToolResult('{"output": "partial\\n[Command interrupted]", "exit_code": 130, "error": null}'), true);
    assert.equal(isInterruptedToolResult("[execution interrupted after 3s]"), true);
    assert.equal(isInterruptedToolResult('{"output":"[Command interrupted]","exit_code":0,"error":null}'), false, "a successful command quoting the marker");
    assert.equal(isInterruptedToolResult('{"output":"[Command interrupted]\\nmore","exit_code":1,"error":null}'), false, "not the last line");
    assert.equal(isInterruptedToolResult('{"error":"Tool execution cancelled. Turn interrupted","status":"cancelled"}'), false);
    assert.equal(isInterruptedToolResult("{not json"), false);
  });

  it("a side-effecting call keeps its block and the model reads that the effect is UNKNOWN", () => {
    const rows = [user("go"), asst([call("c1", "terminal")]), tool("c1", "terminal", INTERRUPTED_COMMAND_RESULT), user("again")];
    const out = stripInterruptedToolTails(rows);
    assert.equal(out.length, 4);
    assert.match(String(out[2]!.content), /^\[Orphan recovery: interrupted side-effecting tool may have executed; its effect is UNKNOWN/);
    assert.equal(rows[2]!.content, INTERRUPTED_COMMAND_RESULT, "the rows are not changed");
  });

  it("in a mixed block, only the interrupted result is rewritten", () => {
    const rows = [asst([call("c1", "read_file"), call("c2", "terminal")]), tool("c1", "read_file", "contents"), tool("c2", "terminal", INTERRUPTED_COMMAND_RESULT)];
    const out = stripInterruptedToolTails(rows);
    assert.deepEqual(out.map((m) => m.content), [null, "contents", out[2]!.content]);
    assert.match(String(out[2]!.content), /UNKNOWN/);
  });

  it("an all read-only block is dropped, and so is an orphan interrupted row", () => {
    const rows = [user("go"), asst([call("c1", "read_file")]), tool("c1", "read_file", "[Command interrupted]"), tool("zz", "terminal", INTERRUPTED_COMMAND_RESULT), user("again")];
    assert.deepEqual(stripInterruptedToolTails(rows).map((m) => m.content), ["go", "again"]);
  });

  it("history without an interrupt is returned as it is", () => {
    const rows = [user("go"), asst([call("c1", "terminal")]), tool("c1", "terminal", '{"output":"hi","exit_code":0,"error":null}')];
    assert.deepEqual(stripInterruptedToolTails(rows), rows);
  });
});

describe("rows that close a stopped turn", () => {
  it("the hidden placeholder is empty to people and labelled for the model", () => {
    const row = interruptPlaceholderRow("t:stop");
    assert.equal(row.content, "");
    assert.equal(row.displayKind, "hidden");
    assert.deepEqual(toApiMessage(row), { role: "assistant", content: INTERRUPTED_PLACEHOLDER });
  });

  it("the failed-turn notice never says 'not processed' when a tool may have run", () => {
    assert.equal(failedTurnRow([user("hi")], "u").content, FAILED_TURN_NOTICE);
    assert.equal(failedTurnRow([user("hi"), asst([call("c1", "terminal")])], "u").content, PARTIAL_FAILED_TURN_NOTICE);
    assert.equal(failedTurnRow([user("hi")], "u").displayKind, "failed_turn");
  });
});
