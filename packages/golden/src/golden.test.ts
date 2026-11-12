import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GOLDEN_FORMAT, type GoldenRecord } from "@hermesd/session-actor";
import { baselineProblems, checkAgainstBaseline, checkRecords, loadBaseline, summarize, type Baseline } from "./baseline.ts";
import { formatDiffs } from "./compare.ts";
import { runScript, serialize, type RunOutput } from "./runner.ts";
import { PORT_DIR, UPSTREAM_DIR, loadScript, scriptNames, type Script } from "./script.ts";

// The 20 golden-transcript scripts of guide 7.2, port side. Each script is played on the
// Node simulator in both modes. The port transcript is committed; the test plays the script
// again and the bytes must be the same. When an upstream transcript exists the two are
// compared. When it does not, that comparison is skipped with the reason.

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const names = scriptNames();
const runs = new Map<string, Promise<RunOutput>>();
const run = (name: string): Promise<RunOutput> => {
  let r = runs.get(name);
  if (!r) {
    r = runScript(loadScript(name));
    runs.set(name, r);
  }
  return r;
};

/** The text of the `tool` message for a call id, from the second request of a run. */
function toolResults(rec: GoldenRecord): string[] {
  return rec.rows.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
}

/** What each script must show beyond the generic `expect` block. These read the record. */
const SPECIFIC: Record<string, (out: RunOutput, s: Script) => void> = {
  "plain-reply": (out) => {
    assert.deepEqual(out.record.rows.messages.map((m) => m.role), ["user", "assistant"]);
  },
  "parallel-tools": (out) => {
    assert.deepEqual(toolResults(out.record).map((t) => (JSON.parse(t) as { output: string }).output), ["one\n", "two\n"], "results in call order");
  },
  "clarify-sequential": (out) => {
    const msgs = out.record.rows.messages;
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant"]);
    assert.equal(msgs[2]!.tool_call_id, "call_1", "the clarify answer comes first");
    assert.deepEqual(out.record.rows.admissions.map((a) => a.input), ["work on my file", "a.txt"], "the answer is the next admission");
  },
  "compaction-50": (out) => assertCompacted(out, "threshold"),
  "compaction-85": (out) => assertCompacted(out, "hygiene"),
  "interrupt-mid-call": (out) => {
    assert.equal(out.record.rows.messages.filter((m) => m.role === "assistant").length, 1, "no row for the dropped answer");
    assert.deepEqual(out.record.rows.admissions.map((a) => a.outcome), ["completed", "completed"]);
  },
  "provider-fallback-429": (out) => {
    const models = out.record.requests.map((r) => (r.body as { model: string }).model);
    assert.deepEqual(models, ["primary-model", "fallback-model"]);
    const [a, b] = out.record.requests.map((r) => (r.body as { messages: unknown }).messages);
    assert.deepEqual(a, b, "the fallback gets the same history");
  },
  "hook-blocks-tool": (out) => assert.deepEqual(toolResults(out.record), ['{"error": "terminal is not allowed here"}']),
  "hook-crashes": (out) => assert.deepEqual(toolResults(out.record), ['{"error": "pre_tool_call plugin callback guard raised RuntimeError: guard failed"}']),
  "hook-time-budget": (out) => assert.deepEqual(toolResults(out.record), ['{"error": "pre_tool_call plugin callback timed out or is still running"}']),
  "persistence-failure-before-tool": (out) => {
    assert.deepEqual(out.record.rows.messages.map((m) => m.role), ["user"], "the failed write left no assistant row");
    assert.deepEqual(out.record.rows.admissions.map((a) => a.outcome), ["failed"]);
  },
  "dropped-stream-mid-token": (out) => {
    const [a, b] = out.record.requests;
    assert.deepEqual(a!.body, b!.body, "the same request goes out again");
    assert.deepEqual(out.record.rows.messages.map((m) => m.role), ["user", "assistant"], "no partial assistant row");
  },
  "cancellation-during-tool": (out) => {
    assert.deepEqual(toolResults(out.record), ['{"error":"the turn was interrupted","status":"cancelled"}']);
  },
  "three-plugins-hook-order": (out) => assert.deepEqual(toolResults(out.record), ['{"error": "policy says no"}'], "directory 10-policy comes before 30-audit"),
  "tool-error-text": (out) => {
    const t = toolResults(out.record);
    assert.deepEqual(
      out.record.rows.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      ["call_1", "call_2", "call_3"],
      "results in call order, though two are answered without the executor",
    );
    assert.equal((JSON.parse(t[0]!) as { exit_code: number }).exit_code, 2);
    assert.equal(t[1], `{"error":"Unknown tool 'frobnicate'"}`);
    assert.equal(t[2], "{\"error\":\"terminal needs a non-empty `command` string\"}");
  },
};

function assertCompacted(out: RunOutput, _reason: string): void {
  const rows = out.record.rows.messages;
  assert.ok(rows.some((m) => m.compacted === 1), "some rows were compacted");
  assert.ok(rows.some((m) => m.content?.includes("CONTEXT COMPACTION")), "a summary row exists");
  const summaryCalls = out.record.requests.filter((r) => (r.body as { messages: unknown[] }).messages.length === 1);
  assert.equal(summaryCalls.length, 1, "one summary request, with the summary prompt only");
}

describe("the 20 scripts", () => {
  it("are 20, named after the files, each with a purpose and a place in the README", () => {
    assert.equal(names.length, 20);
    for (const n of names) {
      const s = loadScript(n);
      assert.ok(README.includes(`| \`${n}\` | ${s.purpose} |`), `README lists ${n} with its purpose`);
    }
    const listed = [...README.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual([...listed].sort(), names, "the README lists exactly the script files");
  });

  it("cover the behaviors that guide 7.2 and 7.4 name", () => {
    for (const want of [
      "plain-reply", "one-tool-call", "parallel-tools", "clarify-sequential", "compaction-50", "compaction-85", "interrupt-mid-call",
      "provider-fallback-429", "format-anthropic-messages", "format-codex-responses", "format-bedrock-converse", "format-chat-completions",
      "hook-blocks-tool", "hook-crashes", "hook-time-budget", "persistence-failure-before-tool",
      "dropped-stream-mid-token", "cancellation-during-tool", "three-plugins-hook-order", "tool-error-text",
    ]) assert.ok(names.includes(want), want);
  });

  it("use each API mode", () => {
    const modes = new Set(names.map((n) => loadScript(n).mode));
    assert.deepEqual([...modes].sort(), ["anthropic_messages", "bedrock_converse", "chat_completions", "codex_responses"]);
  });
});

describe("port transcripts: played on node/durable-objects and node/rivet", () => {
  for (const name of names) {
    it(`${name}: the outcome is as the script says, and the committed transcript is reproduced`, async () => {
      const script = loadScript(name);
      const out = await run(name);
      assert.deepEqual(out.replies, script.expect.replies, "replies");
      assert.equal(out.record.requests.length, script.expect.requests, "requests that reached the model");
      assert.equal(out.toolRuns, script.expect.toolRuns, "tool runs");
      assert.deepEqual(out.hookLog, script.expect.hookLog ?? [], "hook log");
      SPECIFIC[name]?.(out, script);

      const file = join(PORT_DIR, `${name}.json`);
      assert.ok(existsSync(file), `${file} is committed (run: bun packages/golden/src/cli.ts record)`);
      assert.equal(serialize(out.record), readFileSync(file, "utf8"), "regenerating gives the committed bytes");
      assert.equal(out.record.side, "port");
      assert.equal(out.record.script, name);
    });
  }

  it("a transcript has no timestamps and no random ids", () => {
    for (const n of names) {
      const text = readFileSync(join(PORT_DIR, `${n}.json`), "utf8");
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:/, `${n}: an ISO timestamp`);
      assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, `${n}: a UUID`);
    }
  });
});

describe("port against upstream", () => {
  const baseline = loadBaseline();

  it("expected-differences.json names real scripts that have an upstream transcript", () => {
    assert.deepEqual(baselineProblems(baseline, names), []);
  });

  for (const name of names) {
    const upstreamFile = join(UPSTREAM_DIR, `${name}.json`);
    if (!existsSync(upstreamFile)) {
      it(`${name}: no upstream transcript`, { skip: `no upstream transcript at transcripts/upstream/${name}.json; record it with packages/golden/UPSTREAM.md` }, () => {});
      continue;
    }
    // The policy of `cli.ts compare`: valid fixtures, and exactly the differences of the baseline (none if it has no entry).
    it(`${name}: the fixture is valid and the differences are exactly the expected ones`, () => {
      const r = checkAgainstBaseline(name, baseline);
      assert.deepEqual(r.problems, [], `\n${formatDiffs(r.diffs)}`);
    });
  }
});

describe("the expected-differences policy", () => {
  const name = "plain-reply";
  const port = JSON.parse(readFileSync(join(PORT_DIR, `${name}.json`), "utf8")) as GoldenRecord;
  const upstream = JSON.parse(readFileSync(join(UPSTREAM_DIR, `${name}.json`), "utf8")) as GoldenRecord;
  const ignore = loadScript(name).upstream.ignore ?? [];
  const base = loadBaseline();
  const check = (up: unknown, b: Baseline = base) => checkRecords(name, port, up, ignore, b).problems;
  const clone = (): GoldenRecord => JSON.parse(JSON.stringify(upstream)) as GoldenRecord;

  it("accepts the recorded fixture", () => assert.deepEqual(check(upstream), []));

  it("rejects a fixture with the right header and empty arrays", () => {
    const empty = { ...clone(), requests: [], rows: { messages: [], admissions: [] } };
    assert.ok(check(empty).some((p) => /no requests/.test(p)));
    assert.ok(check(empty).some((p) => /no messages rows/.test(p)));
  });

  it("rejects the wrong script, side or format", () => {
    assert.ok(check({ ...clone(), script: "one-tool-call" }).some((p) => /records script/.test(p)));
    assert.ok(check({ ...clone(), side: "port" }).some((p) => /side/.test(p)));
    assert.ok(check({ ...clone(), format: "hermesd-golden/0" }).some((p) => /format/.test(p)));
  });

  it("rejects a new regression next to an existing mismatch", () => {
    const up = clone();
    up.rows.messages[1]!.content = "something else entirely";
    assert.ok(check(up).some((p) => /changed from the baseline/.test(p)), "changed difference");
  });

  it("rejects a script with no baseline entry that differs, and an entry that vanished", () => {
    assert.ok(check(upstream, { note: "", scripts: {} }).some((p) => /does not list/.test(p)));
    assert.ok(checkRecords(name, port, port, ignore, base).problems.some((p) => /now agrees|side/.test(p)));
    const same = JSON.parse(JSON.stringify(port)) as GoldenRecord;
    same.side = "upstream";
    assert.ok(checkRecords(name, port, same, ignore, base).problems.some((p) => /now agrees/.test(p)));
  });

  it("summarize is stable and sensitive to values", () => {
    const d = [{ where: "request 0", field: "requests[0].x", port: 1, upstream: 2 }];
    assert.equal(summarize(d).digest, summarize(structuredClone(d)).digest);
    assert.notEqual(summarize(d).digest, summarize([{ ...d[0]!, upstream: 3 }]).digest);
  });
});
