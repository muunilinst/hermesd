import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_CONFIGS, createLoopWorld, tick, type LoopWorld, type LoopWorldOptions, type NodeBackendOptions } from "@hermesd/faults";
import { PluginHost, type HookLogEntry } from "@hermesd/plugin-host";
import { MODELS, ScriptedModel, createModelClient, type ModelClient } from "@hermesd/providers";
import { GOLDEN_FORMAT, goldenAdmissions, goldenMessages, type GoldenRecord, type LoopHooks, type ToolName } from "@hermesd/session-actor";
import { expandText, type HookPlugin, type Script } from "./script.ts";

/**
 * The port runner (guide 7.2). It plays one script through the session actor on
 * the Node simulator and records every request that reached the model, in order,
 * and the `messages` and `session_admissions` rows that the run wrote.
 *
 * Nothing in the record is random: the platform clock is virtual, ids come from
 * the script or are derived from it, and the record holds no timestamps and no
 * call ids. Two runs give the same bytes. The tests check that.
 */

/** The address in the port requests. Nothing connects to it: the scripted model answers in process. */
const BASE_URL = "http://127.0.0.1:8089";
const WAIT_MS = 20_000;

export interface RunOutput {
  record: GoldenRecord;
  /** The text of each reply the user got. */
  replies: string[];
  /** Tool commands that ran in the executor. */
  toolRuns: number;
  /** Hook log lines, `kind:plugin`. */
  hookLog: string[];
}

interface Target {
  model: ScriptedModel;
  client: ModelClient;
}

interface Seen {
  callId: string | null;
  path: string;
  body: unknown;
}

/**
 * The model behind `Host.fetch`: it records each request in order and gives it to the
 * scripted model of its target. The fallback target is chosen by the `model` field.
 */
class RecordingModel {
  readonly requests: Seen[] = [];
  readonly primary: Target;
  readonly fallback: (Target & { name: string }) | undefined;

  constructor(primary: Target, fallback: (Target & { name: string }) | undefined) {
    this.primary = primary;
    this.fallback = fallback;
  }

  get aborted(): number {
    return this.primary.model.aborted + (this.fallback?.model.aborted ?? 0);
  }

  release(name: string): void {
    this.primary.model.release(name);
    this.fallback?.model.release(name);
  }

  /** Requests whose answer (and, for a stream, whose body) has not been fully read yet. */
  inFlight = 0;
  /** Answers that the loop will try again later: an error status, or a body that broke. Each needs one wake. */
  failures = 0;
  /** The failures that the runner has answered with a wake. */
  wakes = 0;

  readonly fetch = async (req: Request, signal?: AbortSignal): Promise<Response> => {
    const body = (await req.clone().json()) as { model?: unknown };
    this.requests.push({ callId: req.headers.get("idempotency-key"), path: new URL(req.url).pathname, body });
    const target = this.fallback && body.model === this.fallback.name ? this.fallback : this.primary;
    this.inFlight += 1;
    let open = true;
    const fail = (): void => {
      if (open) this.failures += 1;
    };
    const done = (): void => {
      if (open) this.inFlight -= 1;
      open = false;
    };
    try {
      const res = await target.model.fetch(req, signal);
      if (res.status >= 400) this.failures += 1;
      if (!res.body) {
        done();
        return res;
      }
      // The request stays in flight until the loop has read the body to its end, or has given up.
      const reader = res.body.getReader();
      const body2 = new ReadableStream<Uint8Array>({
        async pull(c) {
          try {
            const r = await reader.read();
            if (r.done) {
              done();
              c.close();
            } else c.enqueue(r.value);
          } catch (e) {
            fail();
            done();
            c.error(e);
          }
        },
        cancel(reason) {
          done();
          return reader.cancel(reason);
        },
      });
      return new Response(body2, { status: res.status, headers: res.headers });
    } catch (e) {
      done();
      throw e;
    }
  };
}

function target(mode: Script["mode"], model: string, stream: boolean, steps: Script["steps"]): Target {
  const urls: Partial<Record<Script["mode"], string>> = {
    chat_completions: `${BASE_URL}/v1/chat/completions`,
    anthropic_messages: `${BASE_URL}/v1/messages`,
    codex_responses: `${BASE_URL}/v1/responses`,
  };
  const url = urls[mode];
  return {
    model: new ScriptedModel(mode, steps, { stream }),
    client: createModelClient(mode, { model, stream, ...(url ? { url } : {}) }),
  };
}

// ---------------------------------------------------------------- plugins

function callbackSource(p: HookPlugin): string {
  const b = p.behavior;
  const head = `function ${p.callback}(kwargs, signal)`;
  switch (b.kind) {
    case "block":
      return `${head} { return { action: "block", message: ${JSON.stringify(b.message)} }; }`;
    case "throw":
      return `${head} { const e = new Error(${JSON.stringify(b.message)}); e.name = ${JSON.stringify(b.error)}; throw e; }`;
    case "hang":
      return `${head} { return new Promise(() => {}); }`;
    case "none":
      return `${head} { return null; }`;
  }
}

/** Write the plugin directories of a script and load them, in the order of the script. */
async function loadPlugins(script: Script, root: string, log: string[]): Promise<PluginHost> {
  const host = new PluginHost({
    ...(script.hooks?.timeoutMs !== undefined ? { timeoutMs: script.hooks.timeoutMs } : {}),
    log: (e: HookLogEntry) => log.push(`${e.kind}:${e.plugin}`),
  });
  for (const p of script.hooks?.plugins ?? []) {
    const dir = join(root, p.dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), `name: ${p.name}\nversion: 1.0.0\nruntime: js\nprovides_hooks: [${p.hook}]\ncapabilities: []\n`);
    await writeFile(join(dir, "index.mjs"), `export function register(ctx) { ctx.registerHook(${JSON.stringify(p.hook)}, ${p.callback}); }\n${callbackSource(p)}\n`);
    await host.load(dir, "first-party");
  }
  return host;
}

// ---------------------------------------------------------------- waiting

/**
 * Wait for `pred`. A model answer that the loop will try again (a 429, a dropped stream) leaves an
 * open obligation, and the loop sleeps until the wake: then the clock moves, once for each such
 * answer. The runner never wakes the loop at any other time, so it does not disturb a step that is
 * half done. While nothing is due (a hook waiting for its real timer), the wait sleeps a little.
 */
async function waitFor(w: LoopWorld, served: RecordingModel, pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  let lastSig = "";
  let quiet = 0;
  while (Date.now() < deadline) {
    for (let i = 0; i < 40; i++) {
      if (pred()) return;
      await tick(2);
    }
    await w.b.settle();
    if (pred()) return;
    const sig = `${served.requests.length}|${w.replies.length}|${served.failures}`;
    quiet = sig === lastSig ? quiet + 1 : 0;
    lastSig = sig;
    const due = served.inFlight === 0 && w.rows("wake_obligations", "state = 'open'").length > 0;
    // A stream that ended early with no error leaves no failure mark: after 80 ms of no change the wake is given too.
    if (due && (served.failures > served.wakes || quiet >= 8)) {
      served.wakes = served.failures;
      quiet = 0;
      await w.wakeAll();
    } else {
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const startsSent = (w: LoopWorld): number => w.link.sent.filter((m) => m.method === "start").length;

function holdNames(script: Script): string[] {
  const names = new Set<string>();
  for (const s of [...script.steps, ...(script.fallback?.steps ?? [])]) if (s.hold) names.add(s.hold);
  for (const c of Object.values(script.commands ?? {})) if (c.hold) names.add(c.hold);
  return [...names];
}

// ---------------------------------------------------------------- one run

export async function runOnce(script: Script, cfg: NodeBackendOptions): Promise<RunOutput> {
  const stream = script.stream ?? false;
  const modelName = script.model ?? MODELS[script.mode];
  const primary = target(script.mode, modelName, stream, script.steps);
  const fb = script.fallback;
  const fallback = fb ? { ...target(fb.mode, fb.model, fb.stream ?? false, fb.steps), name: fb.model } : undefined;
  const served = new RecordingModel(primary, fallback);

  const hookLog: string[] = [];
  const pluginRoot = await mkdtemp(join(tmpdir(), "golden-plugins-"));
  try {
    const host = script.hooks ? await loadPlugins(script, pluginRoot, hookLog) : undefined;
    const commands = script.commands ?? {};
    const opts: LoopWorldOptions = {
      script: [],
      provider: { client: primary.client, model: served },
      loop: {
        model: modelName,
        buildCommand: (a) => ({ argv: ["scripted", JSON.stringify(commands[a.command] ?? {})] }),
        ...(script.config?.contextWindow !== undefined ? { contextWindow: script.config.contextWindow } : {}),
        ...(script.config?.compression ? { compression: script.config.compression } : {}),
        ...(script.config?.tools ? { tools: script.config.tools as ToolName[] } : {}),
        ...(script.config?.systemPrompt ? { systemPrompt: script.config.systemPrompt } : {}),
      },
      ...(host ? { hooks: host.hooks as LoopHooks } : {}),
      ...(fallback ? { fallback: { client: fallback.client, model: fallback.name } } : {}),
    };
    const w = await createLoopWorld(cfg, opts);
    try {
      if (script.fault?.kind === "persistence_failure_after_model") {
        // After the model answered, the next write fails once.
        w.b.onPoint({ actor: "s1", point: "fetch:after" }, () => {
          w.b.onPoint({ actor: "s1", point: "tx:before" }, () => {
            throw new Error("disk full");
          });
        });
      }
      for (const input of script.inputs) {
        const repliesBefore = w.replies.length;
        const requestsBefore = served.requests.length;
        const startsBefore = startsSent(w);
        await w.send(expandText(input.send));
        if (input.interrupt === "model_call") {
          await waitFor(w, served, () => served.requests.length > requestsBefore, "the held model request");
        } else if (input.interrupt === "tool_running") {
          await waitFor(w, served, () => startsSent(w) > startsBefore, "the running tool command");
        }
        if (input.interrupt) await w.stop(); // not after settle(): the held request would never let it return
        await waitFor(w, served, () => w.replies.length > repliesBefore, `the reply to input "${expandText(input.send).slice(0, 30)}"`);
        if (input.interrupt) {
          // The late answer and the late command result have nobody to go to.
          for (const h of holdNames(script)) {
            served.release(h);
            w.rig.commands.release(h);
          }
          await w.rig.settle();
          await w.b.call("s1", "op_event", {}).catch(() => undefined);
        }
        await w.b.settle();
      }
      await w.b.settle();
      const record: GoldenRecord = {
        format: GOLDEN_FORMAT,
        side: "port",
        script: script.name,
        requests: served.requests.map((r, index) => ({ index, method: "POST", path: r.path, body: r.body })),
        rows: { messages: goldenMessages(w.rows("messages")), admissions: goldenAdmissions(w.rows("session_admissions")) },
      };
      return { record, replies: w.replies.map((r) => r.text), toolRuns: w.rig.guest.totalRuns(), hookLog };
    } finally {
      w.b.close();
    }
  } finally {
    await rm(pluginRoot, { recursive: true, force: true });
  }
}

/**
 * Play a script on both simulator modes. The two records must be the same: the
 * loop does not depend on the host. Returns the record of the first mode.
 */
export async function runScript(script: Script): Promise<RunOutput> {
  const outputs: RunOutput[] = [];
  for (const cfg of NODE_CONFIGS) outputs.push(await runOnce(script, cfg));
  const first = outputs[0]!;
  for (let i = 1; i < outputs.length; i++) {
    const other = outputs[i]!;
    if (JSON.stringify(other.record) !== JSON.stringify(first.record)) {
      throw new Error(`script ${script.name}: the records of node/${NODE_CONFIGS[0]!.mode} and node/${NODE_CONFIGS[i]!.mode} differ`);
    }
    assert.deepEqual(other.replies, first.replies, `script ${script.name}: replies differ between modes`);
    assert.equal(other.toolRuns, first.toolRuns, `script ${script.name}: tool runs differ between modes`);
    assert.deepEqual(other.hookLog, first.hookLog, `script ${script.name}: hook logs differ between modes`);
  }
  return first;
}

/** The committed text of a transcript: JSON with two-space indent and a final newline. */
export function serialize(record: GoldenRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
