import { encodeEventStreamFrame } from "./bedrock.ts";
import type { ApiMode, Dict } from "./types.ts";

/**
 * A scripted model for each API mode (guide 7.2). It gives fixed answers, in order,
 * in the wire format of the mode, so one golden-transcript script runs in every format.
 *
 * It has the same step fields as `session-actor/src/model/scripted.ts` (`reply`,
 * `toolCalls`, `status`, `times`, `hold`, `drop`, `usage`) and adds:
 * - `retryAfter`: a `Retry-After` header for a `status` answer.
 * - `dropAfter`, `dropTimes`, `dropMode`: a streamed answer that is cut in the middle.
 * - `chunks`: how many pieces the text and the tool arguments are split into in a stream.
 *
 * One call id gets one step. A re-send with the same call id gets the same step
 * (the idempotency key). A new call id takes the next step.
 */

export interface ScriptedToolCall {
  name: string;
  /** An object (it is stringified) or a string. */
  arguments: unknown;
  id?: string;
}

export interface ScriptStep {
  reply?: string;
  toolCalls?: ScriptedToolCall[];
  status?: number;
  /** With `status`: only the first n requests of this step fail. Later requests get the normal answer. */
  times?: number;
  retryAfter?: number | string;
  /** An error message for the `status` answer. Default `scripted status N`. */
  errorMessage?: string;
  /** Wait until `release(hold)` is called. An abort ends the wait. */
  hold?: string;
  /** Never answer. Only an abort ends the request. */
  drop?: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Streaming: stop after this many frames, with no terminal event. */
  dropAfter?: number;
  /** How many requests of this step are cut. Default 1. */
  dropTimes?: number;
  /** `close` ends the body early; `error` breaks the connection. Default `close`. */
  dropMode?: "close" | "error";
  /** Streaming: pieces per text or argument string. Default 2. */
  chunks?: number;
}

export interface RecordedCall {
  index: number;
  callId: string | null;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ScriptedModelOptions {
  stream?: boolean;
}

interface Resolved {
  text: string | null;
  calls: Array<{ id: string; name: string; args: string }>;
  usage: { prompt: number; completion: number };
  model: string;
  id: string;
}

const enc = new TextEncoder();

function pieces(text: string, n: number): string[] {
  if (text.length === 0) return [""];
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, n)));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const sse = (data: unknown, event?: string): Uint8Array => enc.encode(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);

// ---------------------------------------------------------------- JSON answers

function jsonAnswer(mode: ApiMode, r: Resolved): Dict {
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
        usage: { prompt_tokens: r.usage.prompt, completion_tokens: r.usage.completion, total_tokens: r.usage.prompt + r.usage.completion },
      };
    case "anthropic_messages":
      return {
        id: `msg_${r.id}`,
        type: "message",
        role: "assistant",
        model: r.model,
        content: [...(r.text ? [{ type: "text", text: r.text }] : []), ...r.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: JSON.parse(c.args || "{}") as unknown }))],
        stop_reason: r.calls.length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: r.usage.prompt, output_tokens: r.usage.completion },
      };
    case "codex_responses":
      return {
        id: `resp_${r.id}`,
        object: "response",
        status: "completed",
        model: r.model,
        output: codexItems(r),
        usage: { input_tokens: r.usage.prompt, output_tokens: r.usage.completion, total_tokens: r.usage.prompt + r.usage.completion },
      };
    case "bedrock_converse":
      return {
        output: {
          message: {
            role: "assistant",
            content: [...(r.text ? [{ text: r.text }] : []), ...r.calls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: JSON.parse(c.args || "{}") as unknown } }))],
          },
        },
        stopReason: r.calls.length > 0 ? "tool_use" : "end_turn",
        usage: { inputTokens: r.usage.prompt, outputTokens: r.usage.completion, totalTokens: r.usage.prompt + r.usage.completion },
      };
  }
}

function codexItems(r: Resolved): Dict[] {
  return [
    ...(r.text ? [{ type: "message", id: `msg_${r.id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: r.text }] }] : []),
    ...r.calls.map((c, i) => ({ type: "function_call", id: `fc_${r.id}_${i}`, call_id: c.id, name: c.name, arguments: c.args, status: "completed" })),
  ];
}

// ---------------------------------------------------------------- streamed answers

function streamFrames(mode: ApiMode, r: Resolved, n: number): Uint8Array[] {
  const f: Uint8Array[] = [];
  switch (mode) {
    case "chat_completions": {
      const chunk = (delta: Dict, finish: string | null = null): Dict => ({ id: `chatcmpl-${r.id}`, object: "chat.completion.chunk", model: r.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      f.push(sse(chunk({ role: "assistant", content: "" })));
      if (r.text) for (const p of pieces(r.text, n)) f.push(sse(chunk({ content: p })));
      r.calls.forEach((c, i) => {
        f.push(sse(chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] })));
        for (const p of pieces(c.args, n)) f.push(sse(chunk({ tool_calls: [{ index: i, function: { arguments: p } }] })));
      });
      f.push(sse(chunk({}, r.calls.length > 0 ? "tool_calls" : "stop")));
      f.push(sse({ id: `chatcmpl-${r.id}`, object: "chat.completion.chunk", model: r.model, choices: [], usage: { prompt_tokens: r.usage.prompt, completion_tokens: r.usage.completion, total_tokens: r.usage.prompt + r.usage.completion } }));
      f.push(sse("[DONE]"));
      return f;
    }
    case "anthropic_messages": {
      const ev = (type: string, body: Dict): void => void f.push(sse({ type, ...body }, type));
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
      return f;
    }
    case "codex_responses": {
      const ev = (type: string, body: Dict): void => void f.push(sse({ type, ...body }, type));
      const items = codexItems(r);
      if (r.text) for (const p of pieces(r.text, n)) ev("response.output_text.delta", { item_id: `msg_${r.id}`, delta: p });
      for (const item of items) ev("response.output_item.done", { item });
      ev("response.completed", { response: jsonAnswer(mode, r) });
      return f;
    }
    case "bedrock_converse": {
      const ev = (type: string, payload: Dict): void => void f.push(encodeEventStreamFrame(type, payload));
      ev("messageStart", { role: "assistant" });
      let index = 0;
      if (r.text) {
        for (const p of pieces(r.text, n)) ev("contentBlockDelta", { contentBlockIndex: index, delta: { text: p } });
        ev("contentBlockStop", { contentBlockIndex: index });
        index += 1;
      }
      for (const c of r.calls) {
        ev("contentBlockStart", { contentBlockIndex: index, start: { toolUse: { toolUseId: c.id, name: c.name } } });
        for (const p of pieces(c.args, n)) ev("contentBlockDelta", { contentBlockIndex: index, delta: { toolUse: { input: p } } });
        ev("contentBlockStop", { contentBlockIndex: index });
        index += 1;
      }
      ev("messageStop", { stopReason: r.calls.length > 0 ? "tool_use" : "end_turn" });
      ev("metadata", { usage: { inputTokens: r.usage.prompt, outputTokens: r.usage.completion, totalTokens: r.usage.prompt + r.usage.completion }, metrics: { latencyMs: 1 } });
      return f;
    }
  }
}

function errorBody(mode: ApiMode, status: number, message: string): Dict {
  switch (mode) {
    case "anthropic_messages":
      return { type: "error", error: { type: status === 429 ? "rate_limit_error" : status === 529 ? "overloaded_error" : "api_error", message } };
    case "bedrock_converse":
      return { message };
    default:
      return { error: { message, type: "scripted_error", code: null } };
  }
}

function expectedPath(mode: ApiMode, stream: boolean): RegExp {
  switch (mode) {
    case "chat_completions":
      return /\/chat\/completions$/;
    case "anthropic_messages":
      return /\/messages$/;
    case "codex_responses":
      return /\/responses$/;
    case "bedrock_converse":
      return stream ? /\/model\/[^/]+\/converse-stream$/ : /\/model\/[^/]+\/converse$/;
  }
}

export class ScriptedModel {
  readonly mode: ApiMode;
  readonly stream: boolean;
  readonly requests: RecordedCall[] = [];
  readonly #steps: ScriptStep[];
  readonly #assigned = new Map<string, number>();
  readonly #gates = new Map<string, { promise: Promise<void>; open: () => void }>();
  readonly #failed = new Map<number, number>();
  readonly #cut = new Map<number, number>();
  #next = 0;
  /** Requests that were aborted before the model answered. */
  aborted = 0;

  constructor(mode: ApiMode, steps: ScriptStep[], opts: ScriptedModelOptions = {}) {
    this.mode = mode;
    this.#steps = steps;
    this.stream = opts.stream ?? false;
  }

  get remaining(): number {
    return this.#steps.length - this.#next;
  }

  #gate(name: string): { promise: Promise<void>; open: () => void } {
    let g = this.#gates.get(name);
    if (!g) {
      let open!: () => void;
      const promise = new Promise<void>((r) => {
        open = r;
      });
      g = { promise, open };
      this.#gates.set(name, g);
    }
    return g;
  }

  release(name: string): void {
    this.#gate(name).open();
  }

  /** The platform `fetch`. */
  readonly fetch = async (req: Request, signal?: AbortSignal): Promise<Response> => {
    const body = (await req.json()) as Dict;
    const url = new URL(req.url);
    const callId = req.headers.get("idempotency-key");
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    this.requests.push({ index: this.requests.length, callId, method: req.method, path: url.pathname, headers, body });
    if (!expectedPath(this.mode, this.stream).test(url.pathname)) return json(404, errorBody(this.mode, 404, `no route for ${url.pathname}`));

    let index = callId !== null ? this.#assigned.get(callId) : undefined;
    if (index === undefined) {
      index = this.#next++;
      if (callId !== null) this.#assigned.set(callId, index);
    }
    const step = this.#steps[index];
    if (!step) return json(500, errorBody(this.mode, 500, "the script has no more steps"));

    const wait = step.drop ? new Promise<void>(() => {}) : step.hold !== undefined ? this.#gate(step.hold).promise : undefined;
    if (wait) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          this.aborted += 1;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        void wait.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
    signal?.throwIfAborted();

    if (step.status !== undefined && step.status >= 400) {
      const n = (this.#failed.get(index) ?? 0) + 1;
      this.#failed.set(index, n);
      if (step.times === undefined || n <= step.times) {
        return json(step.status, errorBody(this.mode, step.status, step.errorMessage ?? `scripted status ${step.status}`), step.retryAfter !== undefined ? { "retry-after": String(step.retryAfter) } : {});
      }
    }
    const resolved: Resolved = {
      text: step.reply ?? null,
      calls: (step.toolCalls ?? []).map((c, i) => ({
        id: c.id ?? (this.mode === "anthropic_messages" ? `toolu_${index}_${i}` : `call_${index}_${i}`),
        name: c.name,
        args: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
      })),
      usage: { prompt: step.usage?.prompt_tokens ?? 10, completion: step.usage?.completion_tokens ?? 5 },
      model: typeof body.model === "string" ? body.model : "scripted",
      id: callId ?? String(index),
    };
    if (!this.stream) return json(200, jsonAnswer(this.mode, resolved));

    let frames = streamFrames(this.mode, resolved, step.chunks ?? 2);
    let mode: "close" | "error" | null = null;
    if (step.dropAfter !== undefined) {
      const used = this.#cut.get(index) ?? 0;
      if (used < (step.dropTimes ?? 1)) {
        this.#cut.set(index, used + 1);
        frames = frames.slice(0, step.dropAfter);
        mode = step.dropMode ?? "close";
      }
    }
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < frames.length) c.enqueue(frames[i++]!);
        else if (mode === "error") c.error(new TypeError("terminated: connection reset"));
        else c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": this.mode === "bedrock_converse" ? "application/vnd.amazon.eventstream" : "text/event-stream" } });
  };
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}
