#!/usr/bin/env node
// Build an upstream transcript from the request log of the scripted server and the state.db that
// Hermes wrote. The output has the same format as the port transcripts (hermesd-golden/1).
//
//   node assemble.mjs <script.json> --log requests.jsonl --db $HERMES_HOME/state.db --out transcripts/upstream/<name>.json
//
// It reads the db read-only with node:sqlite (Node 22.5 or newer). Use one fresh HERMES_HOME for each
// scenario, so the db holds the rows of this scenario only. Plain Node, no dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { arg, loadScript } from "./common.mjs";

const file = process.argv[2];
const logFile = arg(process.argv, "log", "requests.jsonl");
const dbFile = arg(process.argv, "db", `${process.env.HERMES_HOME ?? `${process.env.HOME}/.hermes`}/state.db`);
const out = arg(process.argv, "out", "");
if (!file || !out) {
  console.error("usage: node assemble.mjs <script.json> --log requests.jsonl --db <state.db> --out <file>");
  process.exit(2);
}
const script = loadScript(file);

const requests = readFileSync(logFile, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l, index) => {
    const r = JSON.parse(l);
    return { index, method: r.method, path: r.path, body: r.body };
  });

const db = new DatabaseSync(dbFile, { readOnly: true });
const json = (v) => (typeof v === "string" ? JSON.parse(v) : null);
const messages = db
  .prepare("SELECT role, content, tool_calls, tool_call_id, tool_name, finish_reason, active, compacted FROM messages ORDER BY id")
  .all()
  .map((r) => ({
    role: String(r.role),
    content: r.content ?? null,
    tool_calls: json(r.tool_calls),
    tool_call_id: r.tool_call_id ?? null,
    tool_name: r.tool_name ?? null,
    finish_reason: r.finish_reason ?? null,
    active: Number(r.active),
    compacted: Number(r.compacted),
  }));

// The input text sits in payload_json. The port writes {"input": ...}. If upstream's key differs,
// the first string among input, text and message is used. Check this on the first recording.
const admissions = db
  .prepare("SELECT status, payload_json, outcome FROM session_admissions ORDER BY seq")
  .all()
  .map((r) => {
    const p = JSON.parse(String(r.payload_json));
    const input = [p.input, p.text, p.message].find((x) => typeof x === "string") ?? JSON.stringify(p);
    return { status: String(r.status), input, outcome: r.outcome ?? null };
  });
db.close();

const record = { format: "hermesd-golden/1", side: "upstream", script: script.name, requests, rows: { messages, admissions } };
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
console.log(`wrote ${out}: ${requests.length} requests, ${messages.length} messages, ${admissions.length} admissions`);
