import { RequestRecorder } from "./recorder.ts";

/**
 * A scripted model (guide 7.2). It gives fixed answers, in order, and speaks
 * the OpenAI chat_completions format. It plugs in as the platform's outbound
 * `fetch`, so the loop reaches it through `Host.fetch` like a real provider.
 *
 * One call ID gets one step. A re-send with the same call ID gets the same
 * answer, as a provider with an idempotency key would give. A new call ID
 * takes the next step.
 */

export interface ScriptedToolCall {
  name: string;
  /** An object (it is stringified) or a string. */
  arguments: unknown;
  id?: string;
}

export interface ModelStep {
  /** A plain answer. */
  reply?: string;
  /** Tool calls. `reply` is then the text that goes with them. */
  toolCalls?: ScriptedToolCall[];
  /** Answer with this HTTP status and no answer body (for example 429). */
  status?: number;
  /** With `status`: only the first n requests of this step fail. Later requests get the normal answer. */
  times?: number;
  /** Wait until `release(hold)` is called. An abort ends the wait. */
  hold?: string;
  /** Never answer. Only an abort ends the request. */
  drop?: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export class ScriptedModel {
  readonly recorder: RequestRecorder;
  readonly #steps: ModelStep[];
  readonly #assigned = new Map<string, number>();
  readonly #gates = new Map<string, { promise: Promise<void>; open: () => void }>();
  readonly #failed = new Map<number, number>();
  #next = 0;
  /** Requests that were aborted before the model answered. */
  aborted = 0;

  constructor(steps: ModelStep[], recorder = new RequestRecorder()) {
    this.#steps = steps;
    this.recorder = recorder;
  }

  /** Steps not yet used. */
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
    const body = (await req.json()) as unknown;
    const url = new URL(req.url);
    const callId = req.headers.get("idempotency-key");
    this.recorder.record({ callId, method: req.method, path: url.pathname, body });

    let index = callId !== null ? this.#assigned.get(callId) : undefined;
    if (index === undefined) {
      index = this.#next++;
      if (callId !== null) this.#assigned.set(callId, index);
    }
    const step = this.#steps[index];
    if (!step) return json(500, { error: { message: "the script has no more steps" } });

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
      if (step.times === undefined || n <= step.times) return json(step.status, { error: { message: `scripted status ${step.status}` } });
    }
    const calls = (step.toolCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_${index}_${i}`,
      type: "function" as const,
      function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments) },
    }));
    return json(200, {
      id: `chatcmpl-${callId ?? index}`,
      object: "chat.completion",
      model: (body as { model?: string }).model ?? "scripted",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: step.reply ?? null, ...(calls.length > 0 ? { tool_calls: calls } : {}) },
          finish_reason: calls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      usage: step.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
