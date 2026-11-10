import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProviderHttpError, createModelClient, type ApiMode, type ModelClient } from "@hermesd/providers";
import { expandText, loadScript, scriptNames, SCRIPTS_DIR } from "./script.ts";

// The standalone scripted server and its helpers (packages/golden/scripted-server). The server
// is checked with the port's own provider clients over real HTTP, so its wire formats are the
// ones that the port parses.

const DIR = new URL("../scripted-server/", import.meta.url).pathname;
const script = (name: string): string => join(SCRIPTS_DIR, `${name}.json`);

interface Running {
  base: string;
  log: string;
  stop(): void;
  requests(): Promise<Array<{ index: number; path: string; body: { model?: string } }>>;
}

async function start(name: string): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "golden-server-"));
  const log = join(dir, "requests.jsonl");
  const child: ChildProcess = spawn(process.execPath, [join(DIR, "server.mjs"), script(name), "--port", "0", "--log", log], { stdio: ["ignore", "pipe", "inherit"] });
  const base = await new Promise<string>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const line = buf.split("\n")[0];
      if (line && buf.includes("\n")) resolve((JSON.parse(line) as { listening: string }).listening);
    });
    child.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
  return {
    base,
    log,
    stop() {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
    requests: async () => (await (await fetch(`${base}/__log`)).json()) as never,
  };
}

const clientFor = (mode: ApiMode, base: string, stream: boolean, model = "m"): ModelClient => {
  const urls: Record<ApiMode, string | undefined> = {
    chat_completions: `${base}/v1/chat/completions`,
    anthropic_messages: `${base}/v1/messages`,
    codex_responses: `${base}/v1/responses`,
    bedrock_converse: undefined,
  };
  return createModelClient(mode, { model, stream, ...(mode === "bedrock_converse" ? { url: base } : { url: urls[mode]! }) });
};

const send = (c: ModelClient, text: string, callId: string) =>
  c.send(c.buildBody({ messages: [{ role: "system", content: "S" }, { role: "user", content: text }], tools: [] }), { callId, fetch: (req, signal) => fetch(req, signal ? { signal } : {}) });

describe("scripted server: the port's clients parse its answers in every mode", () => {
  for (const mode of ["chat_completions", "anthropic_messages", "codex_responses", "bedrock_converse"] as const) {
    for (const stream of mode === "bedrock_converse" ? [false] : [false, true]) {
      it(`${mode} ${stream ? "streamed" : "plain"}: a tool call, then a reply`, async () => {
        const s = await start("one-tool-call");
        try {
          const c = clientFor(mode, s.base, stream);
          const first = await send(c, "go", "c1");
          assert.equal(first.response.content, "I will run it.");
          assert.equal(first.response.toolCalls.length, 1);
          assert.equal(first.response.toolCalls[0]!.function.name, "terminal");
          assert.deepEqual(JSON.parse(first.response.toolCalls[0]!.function.arguments), { command: "echo hello" });
          const second = await send(c, "go", "c2");
          assert.equal(second.response.content, "It printed hello.");
          assert.equal(second.response.toolCalls.length, 0);
          const logged = await s.requests();
          assert.equal(logged.length, 2);
          assert.match(logged[0]!.path, mode === "bedrock_converse" ? /\/model\/.+\/converse$/ : /\/(chat\/completions|messages|responses)$/);
          // The log file has the same requests, one JSON line each.
          const lines = readFileSync(s.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { index: number });
          assert.deepEqual(lines.map((l) => l.index), [0, 1]);
        } finally {
          s.stop();
        }
      });
    }
  }

  it("a model name picks the step list: the fallback model answers after the primary gives 429", async () => {
    const s = await start("provider-fallback-429");
    try {
      const primary = clientFor("chat_completions", s.base, false, "primary-model");
      await assert.rejects(send(primary, "hi", "c1"), (e: unknown) => e instanceof ProviderHttpError && e.status === 429);
      await assert.rejects(send(primary, "hi", "c1"), (e: unknown) => e instanceof ProviderHttpError && e.status === 429, "it fails every time");
      const fallback = clientFor("chat_completions", s.base, false, "fallback-model");
      assert.equal((await send(fallback, "hi", "c1")).response.content, "Answered by the fallback model.");
      assert.deepEqual((await s.requests()).map((r) => r.body.model), ["primary-model", "primary-model", "fallback-model"]);
    } finally {
      s.stop();
    }
  });

  it("a streamed step with dropAfter is cut once, then the whole answer comes", async () => {
    const s = await start("dropped-stream-mid-token");
    try {
      const c = clientFor("chat_completions", s.base, true);
      await assert.rejects(send(c, "build it", "c1"), (e: unknown) => e instanceof Error && e.name === "StreamDroppedError");
      assert.equal((await send(c, "build it", "c1")).response.content, "I will start the build now");
    } finally {
      s.stop();
    }
  });

  it("a held step waits for POST /__release/<name>", async () => {
    const s = await start("interrupt-mid-call");
    try {
      const c = clientFor("chat_completions", s.base, false);
      let done = false;
      const p = send(c, "hi", "c1").then((r) => ((done = true), r));
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(done, false, "the answer is held");
      assert.equal((await fetch(`${s.base}/__release/g1`, { method: "POST" })).status, 200);
      assert.equal((await p).response.content, "too late");
    } finally {
      s.stop();
    }
  });
});

describe("scripted server helpers", () => {
  it("inputs.mjs prints the inputs the port runner plays, with the same expanded text", () => {
    for (const name of ["compaction-50", "interrupt-mid-call", "clarify-sequential"]) {
      const out = spawnSync(process.execPath, [join(DIR, "inputs.mjs"), script(name)], { encoding: "utf8" });
      assert.equal(out.status, 0, out.stderr);
      const printed = out.stdout.trim().split("\n").map((l) => JSON.parse(l) as { send: string; interrupt?: string });
      const s = loadScript(name);
      assert.deepEqual(printed.map((p) => p.send), s.inputs.map((i) => expandText(i.send)));
      assert.deepEqual(printed.map((p) => p.interrupt), s.inputs.map((i) => i.interrupt));
    }
  });

  it("make-plugins.mjs writes one Python plugin for each hook plugin, and nothing for other scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "golden-plugins-"));
    try {
      const none = spawnSync(process.execPath, [join(DIR, "make-plugins.mjs"), script("plain-reply"), root], { encoding: "utf8" });
      assert.equal(none.status, 0);
      assert.equal(none.stdout.trim(), "");
      for (const name of scriptNames().filter((n) => loadScript(n).hooks)) {
        const out = spawnSync(process.execPath, [join(DIR, "make-plugins.mjs"), script(name), root], { encoding: "utf8" });
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stdout, /hook_callback_timeout: /);
        for (const p of loadScript(name).hooks!.plugins) {
          const py = readFileSync(join(root, p.dir, "__init__.py"), "utf8");
          assert.match(py, new RegExp(`def ${p.callback}\\(\\*\\*kwargs\\):`));
          assert.match(py, new RegExp(`ctx.register_hook\\("pre_tool_call", ${p.callback}\\)`));
          assert.match(readFileSync(join(root, p.dir, "plugin.yaml"), "utf8"), new RegExp(`^name: ${p.name}$`, "m"));
        }
      }
      const crash = readFileSync(join(root, "guard", "__init__.py"), "utf8");
      assert.match(crash, /time\.sleep|raise RuntimeError\("guard failed"\)|"action": "block"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assemble.mjs builds a transcript in the shared format from a request log and a state.db", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "golden-assemble-"));
    try {
      const db = new DatabaseSync(join(dir, "state.db"));
      db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, finish_reason TEXT, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE session_admissions (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload_json TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT);
        INSERT INTO messages (session_id, role, content) VALUES ('s', 'user', 'hi');
        INSERT INTO messages (session_id, role, content, finish_reason) VALUES ('s', 'assistant', 'hello', 'stop');
        INSERT INTO session_admissions (payload_json, status, outcome) VALUES ('{"input":"hi"}', 'terminal', 'completed');`);
      db.close();
      const log = join(dir, "requests.jsonl");
      const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
      await import("node:fs").then((fs) => fs.writeFileSync(log, `${JSON.stringify({ index: 0, method: "POST", path: "/v1/chat/completions", body })}\n`));
      const out = join(dir, "t.json");
      const r = spawnSync(process.execPath, [join(DIR, "assemble.mjs"), script("plain-reply"), "--log", log, "--db", join(dir, "state.db"), "--out", out], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const rec = JSON.parse(readFileSync(out, "utf8")) as { format: string; side: string; script: string; requests: unknown[]; rows: { messages: Array<{ role: string }>; admissions: unknown[] } };
      assert.equal(rec.format, "hermesd-golden/1");
      assert.equal(rec.side, "upstream");
      assert.equal(rec.script, "plain-reply");
      assert.deepEqual(rec.requests, [{ index: 0, method: "POST", path: "/v1/chat/completions", body }]);
      assert.deepEqual(rec.rows.messages.map((m) => m.role), ["user", "assistant"]);
      assert.deepEqual(rec.rows.admissions, [{ status: "terminal", input: "hi", outcome: "completed" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
