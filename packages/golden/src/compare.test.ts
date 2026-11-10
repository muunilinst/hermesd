import assert from "node:assert/strict";
import { it } from "node:test";
import { GOLDEN_FORMAT, type GoldenMessage, type GoldenRecord } from "@hermesd/session-actor";
import { compareTranscripts, formatDiffs, pathMatches } from "./compare.ts";

const msg = (role: string, content: string | null, extra: Partial<GoldenMessage> = {}): GoldenMessage => ({
  role,
  content,
  tool_calls: null,
  tool_call_id: null,
  tool_name: null,
  finish_reason: null,
  active: 1,
  compacted: 0,
  ...extra,
});

function record(side: "port" | "upstream", over: Partial<GoldenRecord> = {}): GoldenRecord {
  return {
    format: GOLDEN_FORMAT,
    side,
    script: "x",
    requests: [
      { index: 0, method: "POST", path: "/v1/chat/completions", body: { model: "m", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }], tools: [{ a: 1 }] } },
      { index: 1, method: "POST", path: "/v1/chat/completions", body: { model: "m", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }, { role: "assistant", content: "yes" }] } },
    ],
    rows: { messages: [msg("user", "hi"), msg("assistant", "yes", { finish_reason: "stop" })], admissions: [{ status: "terminal", input: "hi", outcome: "completed" }] },
    ...over,
  };
}

it("equal records have no differences, whatever the key order", () => {
  const a = record("port");
  const b = record("upstream");
  // Same body, other key order.
  b.requests[0]!.body = { tools: [{ a: 1 }], messages: [{ content: "S", role: "system" }, { content: "hi", role: "user" }], model: "m" };
  assert.deepEqual(compareTranscripts(a, b), []);
  assert.equal(formatDiffs([]), "no differences");
});

it("names the request index and the field path of a difference", () => {
  const a = record("port");
  const b = record("upstream");
  (b.requests[1]!.body as { messages: Array<{ content: string }> }).messages[2]!.content = "no";
  const diffs = compareTranscripts(a, b);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]!.where, "request 1");
  assert.equal(diffs[0]!.field, "requests[1].body.messages[2].content");
  assert.equal(diffs[0]!.port, "yes");
  assert.equal(diffs[0]!.upstream, "no");
  assert.equal(formatDiffs(diffs), 'request 1: requests[1].body.messages[2].content\n  port:     "yes"\n  upstream: "no"');
});

it("reports a missing request, a missing field and a different row", () => {
  const a = record("port");
  const b = record("upstream");
  b.requests.pop();
  delete (b.requests[0]!.body as { tools?: unknown }).tools;
  b.rows.messages[1]!.content = "maybe";
  b.rows.admissions[0]!.outcome = "failed";
  const diffs = compareTranscripts(a, b);
  const where = diffs.map((d) => `${d.where} | ${d.field}`);
  assert.deepEqual(where, [
    "request count | ",
    "request 0 | requests[0].body.tools",
    "request 1 | requests[1]",
    "messages row 1 | rows.messages[1].content",
    "admissions row 0 | rows.admissions[0].outcome",
  ]);
  assert.equal(diffs[1]!.upstream, "<absent>");
});

it("ignores dates, because the summary prompt carries the date of the day", () => {
  const a = record("port");
  const b = record("upstream");
  (a.requests[0]!.body as { messages: Array<{ content: string }> }).messages[1]!.content = "today is 2026-11-10";
  (b.requests[0]!.body as { messages: Array<{ content: string }> }).messages[1]!.content = "today is 2027-01-02";
  assert.deepEqual(compareTranscripts(a, b), []);
});

it("ignore paths: a prefix, [*] for any index, and the tokens @system and @tools", () => {
  assert.equal(pathMatches("requests[*].body.tools", "requests[3].body.tools[0].name"), true);
  assert.equal(pathMatches("requests[1].body", "requests[3].body.tools"), false);
  assert.equal(pathMatches("requests[*].body.tool", "requests[3].body.tools"), false, "a name is matched whole");
  const a = record("port");
  const b = record("upstream");
  (b.requests[0]!.body as { messages: Array<{ content: string }> }).messages[0]!.content = "another system prompt";
  (b.requests[0]!.body as { tools: unknown }).tools = [{ a: 2 }];
  assert.equal(compareTranscripts(a, b).length, 2);
  assert.deepEqual(compareTranscripts(a, b, { ignore: ["@system", "@tools"] }), []);
  assert.equal(compareTranscripts(a, b, { ignore: ["requests[*].body.tools"] }).length, 1);
  assert.deepEqual(compareTranscripts(a, b, { ignore: ["requests[0].body.messages[0]", "requests[0].body.tools"] }), []);
});

it("@system works for the system field and instructions of the other API modes", () => {
  const a = record("port");
  const b = record("upstream");
  a.requests = [{ index: 0, method: "POST", path: "/v1/messages", body: { system: "A", messages: [] } }];
  b.requests = [{ index: 0, method: "POST", path: "/v1/messages", body: { system: "B", messages: [] } }];
  assert.deepEqual(compareTranscripts(a, b).map((d) => d.field), ["requests[0].body.system"]);
  assert.deepEqual(compareTranscripts(a, b, { ignore: ["@system"] }), []);
  a.requests = [{ index: 0, method: "POST", path: "/v1/responses", body: { instructions: "A", input: [] } }];
  b.requests = [{ index: 0, method: "POST", path: "/v1/responses", body: { instructions: "B", input: [] } }];
  assert.deepEqual(compareTranscripts(a, b, { ignore: ["@system"] }), []);
});
