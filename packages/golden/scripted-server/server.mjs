#!/usr/bin/env node
// The scripted model server for upstream recording (guide 7.2).
//
// It reads one golden script, serves its model answers over HTTP, and logs every
// request it gets, in order, as one JSON line. Plain Node, no dependencies.
//
//   node server.mjs <script.json> [--port 8089] [--log requests.jsonl]
//
// Routes (any prefix before them is fine, so a base URL of http://127.0.0.1:8089/v1 works):
//   POST .../chat/completions     chat_completions, plain or SSE (when the body has "stream": true)
//   POST .../messages             anthropic_messages, plain or SSE
//   POST .../responses            codex_responses, plain or SSE
//   POST .../model/<id>/converse  bedrock_converse, plain only (turn streaming off in Hermes)
//   POST /__release/<name>        open a hold (a step with "hold": "<name>" waits for this)
//   GET  /__log                   the requests so far, as a JSON array
//
// How steps are chosen: the server has one list of steps for the primary model and, when the
// script has a "fallback", one for the fallback model. A request whose "model" field is the
// fallback model name takes the fallback list. Each list has a pointer. A step answers and the
// pointer moves on. A step with "status" (an error) answers with that status; with "times": n it
// does so n times and then answers normally; without "times" it fails every time.
// A streamed step with "dropAfter": k sends k frames and then cuts the connection (once, or
// "dropTimes" times). The port's ScriptedModel (packages/providers/src/scripted.ts) has the same
// step fields and gives the same answers.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { arg, loadScript } from "./common.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node server.mjs <script.json> [--port 8089] [--log requests.jsonl]");
  process.exit(2);
}
const script = loadScript(file);
const port = Number(arg(process.argv, "port", "8089"));
const logFile = arg(process.argv, "log", "requests.jsonl");
writeFileSync(logFile, "");

const lists = new Map();
lists.set("primary", { steps: script.steps, next: 0, failed: new Map(), cut: new Map() });
if (script.fallback) lists.set(script.fallback.model, { steps: script.fallback.steps, next: 0, failed: new Map(), cut: new Map() });
const gates = new Map();
const log = [];

function gate(name) {
  let g = gates.get(name);
  if (!g) {
    let open;
    const promise = new Promise((r) => (open = r));
    g = { promise, open };
    gates.set(name, g);
  }
  return g;
}

const sse = (data, event) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

function pieces(text, n) {
  if (text.length === 0) return [""];
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, n)));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function modeOf(path) {
  if (/\/chat\/completions$/.test(path)) return "chat_completions";
  if (/\/messages$/.test(path)) return "anthropic_messages";
  if (/\/responses$/.test(path)) return "codex_responses";
  if (/\/model\/[^/]+\/converse$/.test(path)) return "bedrock_converse";
  if (/\/model\/[^/]+\/converse-stream$/.test(path)) return "bedrock_stream";
  return null;
}

function errorBody(mode, status, message) {
  if (mode === "anthropic_messages") return { type: "error", error: { type: status === 429 ? "rate_limit_error" : status === 529 ? "overloaded_error" : "api_error", message } };
  if (mode === "bedrock_converse") return { message };
  return { error: { message, type: "scripted_error", code: null } };
}

function codexItems(r) {
  return [
    ...(r.text ? [{ type: "message", id: `msg_${r.id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: r.text }] }] : []),
    ...r.calls.map((c, i) => ({ type: "function_call", id: `fc_${r.id}_${i}`, call_id: c.id, name: c.name, arguments: c.args, status: "completed" })),
  ];
}

function jsonAnswer(mode, r) {
  const total = r.usage.prompt + r.usage.completion;
  switch (mode) {
    case "chat_completions":
      return {
        id: `chatcmpl-${r.id}`,
        object: "chat.completion",
        model: r.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: r.text,
              ...(r.calls.length > 0 ? { tool_calls: r.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) } : {}),
            },
            finish_reason: r.calls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: r.usage.prompt, completion_tokens: r.usage.completion, total_tokens: total },
      };
    case "anthropic_messages":
      return {
        id: `msg_${r.id}`,
        type: "message",
        role: "assistant",
        model: r.model,
        content: [...(r.text ? [{ type: "text", text: r.text }] : []), ...r.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: JSON.parse(c.args || "{}") }))],
        stop_reason: r.calls.length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: r.usage.prompt, output_tokens: r.usage.completion },
      };
    case "codex_responses":
      return { id: `resp_${r.id}`, object: "response", status: "completed", model: r.model, output: codexItems(r), usage: { input_tokens: r.usage.prompt, output_tokens: r.usage.completion, total_tokens: total } };
    default:
      return {
        output: { message: { role: "assistant", content: [...(r.text ? [{ text: r.text }] : []), ...r.calls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: JSON.parse(c.args || "{}") } }))] } },
        stopReason: r.calls.length > 0 ? "tool_use" : "end_turn",
        usage: { inputTokens: r.usage.prompt, outputTokens: r.usage.completion, totalTokens: total },
      };
  }
}

function streamFrames(mode, r, n) {
  const f = [];
  if (mode === "chat_completions") {
    const chunk = (delta, finish = null) => ({ id: `chatcmpl-${r.id}`, object: "chat.completion.chunk", model: r.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    f.push(sse(chunk({ role: "assistant", content: "" })));
    if (r.text) for (const p of pieces(r.text, n)) f.push(sse(chunk({ content: p })));
    r.calls.forEach((c, i) => {
      f.push(sse(chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] })));
      for (const p of pieces(c.args, n)) f.push(sse(chunk({ tool_calls: [{ index: i, function: { arguments: p } }] })));
    });
    f.push(sse(chunk({}, r.calls.length > 0 ? "tool_calls" : "stop")));
    f.push(sse({ id: `chatcmpl-${r.id}`, object: "chat.completion.chunk", model: r.model, choices: [], usage: { prompt_tokens: r.usage.prompt, completion_tokens: r.usage.completion, total_tokens: r.usage.prompt + r.usage.completion } }));
    f.push(sse("[DONE]"));
  } else if (mode === "anthropic_messages") {
    const ev = (type, body) => f.push(sse({ type, ...body }, type));
    ev("message_start", { message: { id: `msg_${r.id}`, type: "message", role: "assistant", model: r.model, content: [], stop_reason: null, usage: { input_tokens: r.usage.prompt, output_tokens: 0 } } });
    let index = 0;
    if (r.text) {
      ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const p of pieces(r.text, n)) ev("content_block_delta", { index, delta: { type: "text_delta", text: p } });
      ev("content_block_stop", { index });
      index += 1;
    }
    for (const c of r.calls) {
      ev("content_block_start", { index, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } });
      for (const p of pieces(c.args, n)) ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: p } });
      ev("content_block_stop", { index });
      index += 1;
    }
    ev("message_delta", { delta: { stop_reason: r.calls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: r.usage.completion } });
    ev("message_stop", {});
  } else {
    const ev = (type, body) => f.push(sse({ type, ...body }, type));
    if (r.text) for (const p of pieces(r.text, n)) ev("response.output_text.delta", { item_id: `msg_${r.id}`, delta: p });
    for (const item of codexItems(r)) ev("response.output_item.done", { item });
    ev("response.completed", { response: jsonAnswer(mode, r) });
  }
  return f;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function answer(req, res, body, mode) {
  const modelName = typeof body.model === "string" ? body.model : "scripted";
  const key = script.fallback && modelName === script.fallback.model ? script.fallback.model : "primary";
  const list = lists.get(key);
  const index = list.next;
  const step = list.steps[index];
  if (!step) return send(res, 500, errorBody(mode, 500, "the script has no more steps"));

  if (step.drop) await new Promise(() => {});
  if (step.hold !== undefined) await gate(step.hold).promise;

  if (step.status !== undefined && step.status >= 400) {
    const n = (list.failed.get(index) ?? 0) + 1;
    list.failed.set(index, n);
    if (step.times === undefined || n <= step.times) {
      return send(res, step.status, errorBody(mode, step.status, step.errorMessage ?? `scripted status ${step.status}`), step.retryAfter !== undefined ? { "retry-after": String(step.retryAfter) } : {});
    }
  }
  const streaming = body.stream === true && mode !== "bedrock_converse";
  const r = {
    text: step.reply ?? null,
    calls: (step.toolCalls ?? []).map((c, i) => ({
      id: c.id ?? (mode === "anthropic_messages" ? `toolu_${index}_${i}` : `call_${index}_${i}`),
      name: c.name,
      args: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
    })),
    usage: { prompt: step.usage?.prompt_tokens ?? 10, completion: step.usage?.completion_tokens ?? 5 },
    model: modelName,
    id: String(log.length - 1),
  };
  if (!streaming) {
    list.next = index + 1;
    return send(res, 200, jsonAnswer(mode, r));
  }
  let frames = streamFrames(mode, r, step.chunks ?? 2);
  let cut = false;
  if (step.dropAfter !== undefined) {
    const used = list.cut.get(index) ?? 0;
    if (used < (step.dropTimes ?? 1)) {
      list.cut.set(index, used + 1);
      frames = frames.slice(0, step.dropAfter);
      cut = true;
    }
  }
  if (!cut) list.next = index + 1;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const frame of frames) res.write(frame);
  // A cut stream ends with no terminal event. "error" breaks the connection (after the frames
  // were sent), "close" ends the body early.
  if (cut && (step.dropMode ?? "close") === "error") res.write("", () => setTimeout(() => res.destroy(), 20));
  else res.end();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/__log") return send(res, 200, log);
  const release = /^\/__release\/(.+)$/.exec(url.pathname);
  if (req.method === "POST" && release) {
    gate(decodeURIComponent(release[1])).open();
    return send(res, 200, { released: release[1] });
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const mode = modeOf(url.pathname);
    if (req.method !== "POST" || !mode) return send(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(res, 400, { error: { message: "the request body is not JSON" } });
    }
    const entry = { index: log.length, method: req.method, path: url.pathname, body };
    log.push(entry);
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    if (mode === "bedrock_stream") return send(res, 501, { message: "the scripted server does not serve bedrock streaming; turn streaming off" });
    answer(req, res, body, mode).catch((e) => {
      if (!res.headersSent) send(res, 500, { error: { message: String(e) } });
      else res.destroy();
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  // One JSON line, so a driver can read the port.
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${addr.port}`, port: addr.port, script: script.name, log: logFile }));
});
