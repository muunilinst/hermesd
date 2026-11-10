/**
 * Hook dispatch with upstream Hermes semantics.
 *
 * - A hook name must be in contracts/known-hooks.json.
 * - Keyword arguments pass through unchanged. They are never checked against a
 *   fixed list, because upstream adds new ones freely.
 * - A callback that throws, or runs past the time budget (30 s by default), is
 *   logged and skipped. The other callbacks still run.
 * - Callbacks run one after the other, in alphabetical order by plugin
 *   directory. That order is what makes the pre_llm_call join stable.
 */
import { readFileSync } from "node:fs";

export type HookKwargs = Readonly<Record<string, unknown>>;

/** A hook callback. Python takes **kwargs; JS takes one object. */
export type HookCallback = (kwargs: HookKwargs, signal: AbortSignal) => unknown | Promise<unknown>;

export interface HookResultEntry {
  /** The plugin name from the manifest. */
  plugin: string;
  /** The plugin directory name. Results are ordered by this. */
  dir: string;
  hook: string;
  value: unknown;
}

export type PreToolCallDecision =
  | { action: "approve" }
  | { action: "block"; message: string; plugin: string };

/**
 * What the agent loop imports. The plugin host implements it.
 */
export interface HookDispatcher {
  /** Run every callback of one hook. Returns the values that were not skipped. */
  invoke(hook: string, kwargs: HookKwargs): Promise<HookResultEntry[]>;
  /**
   * pre_llm_call: the context texts of all plugins, joined with a blank line
   * in alphabetical order by plugin directory. `null` if there is none.
   */
  preLlmCall(kwargs: HookKwargs): Promise<string | null>;
  /**
   * pre_tool_call: `{action: "block"}` from the first plugin (in directory
   * order) that returns it wins. Otherwise `{action: "approve"}`.
   */
  preToolCall(kwargs: HookKwargs): Promise<PreToolCallDecision>;
}

export class UnknownHookError extends Error {
  readonly hook: string;
  constructor(hook: string) {
    super(`unknown hook name: ${hook}`);
    this.name = "UnknownHookError";
    this.hook = hook;
  }
}

let cachedNames: ReadonlySet<string> | undefined;

/** The reviewed hook names (contracts/known-hooks.json). */
export function knownHookNames(): ReadonlySet<string> {
  if (!cachedNames) {
    const url = new URL("../../../contracts/known-hooks.json", import.meta.url);
    const doc = JSON.parse(readFileSync(url, "utf8")) as { hooks: string[] };
    cachedNames = new Set(doc.hooks);
  }
  return cachedNames;
}

/** A clock that tests can replace. `after` returns a cancel function. */
export interface Timers {
  after(ms: number, fn: () => void): () => void;
}

export const realTimers: Timers = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

export interface HookLogEntry {
  kind: "error" | "timeout";
  plugin: string;
  hook: string;
  message: string;
}

export interface HookRegistration {
  plugin: string;
  dir: string;
  hook: string;
  run: HookCallback;
}

export interface HookRegistryOptions {
  timeoutMs?: number;
  timers?: Timers;
  log?: (entry: HookLogEntry) => void;
}

export class HookRegistry implements HookDispatcher {
  readonly #regs: HookRegistration[] = [];
  readonly timeoutMs: number;
  readonly #timers: Timers;
  readonly #log: (entry: HookLogEntry) => void;

  constructor(opts: HookRegistryOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    this.#timers = opts.timers ?? realTimers;
    this.#log = opts.log ?? (() => {});
  }

  register(reg: HookRegistration): void {
    if (!knownHookNames().has(reg.hook)) throw new UnknownHookError(reg.hook);
    this.#regs.push(reg);
  }

  /** Remove all registrations of one plugin. */
  unregister(plugin: string): void {
    for (let i = this.#regs.length - 1; i >= 0; i--) if (this.#regs[i]!.plugin === plugin) this.#regs.splice(i, 1);
  }

  async invoke(hook: string, kwargs: HookKwargs): Promise<HookResultEntry[]> {
    if (!knownHookNames().has(hook)) throw new UnknownHookError(hook);
    // Array.sort is stable, so one plugin keeps its registration order.
    const regs = this.#regs
      .filter((r) => r.hook === hook)
      .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
    const out: HookResultEntry[] = [];
    for (const reg of regs) {
      const res = await this.#runOne(reg, kwargs);
      if (res.ok) out.push({ plugin: reg.plugin, dir: reg.dir, hook, value: res.value });
    }
    return out;
  }

  async #runOne(reg: HookRegistration, kwargs: HookKwargs): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const ac = new AbortController();
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: { ok: true; value: unknown } | { ok: false }) => {
        if (done) return;
        done = true;
        cancel();
        resolve(r);
      };
      const cancel = this.#timers.after(this.timeoutMs, () => {
        // A timeout counts as a crash. The signal lets async code stop early.
        // A synchronous loop cannot be stopped here (see NOTES.md).
        ac.abort();
        this.#log({ kind: "timeout", plugin: reg.plugin, hook: reg.hook, message: `no result after ${this.timeoutMs} ms` });
        finish({ ok: false });
      });
      Promise.resolve()
        // Each callback gets its own shallow copy, so one cannot change the next one's view.
        .then(() => reg.run({ ...kwargs }, ac.signal))
        .then(
          (value) => finish({ ok: true, value }),
          (err: unknown) => {
            if (!done) this.#log({ kind: "error", plugin: reg.plugin, hook: reg.hook, message: String(err) });
            finish({ ok: false });
          },
        );
    });
  }

  async preLlmCall(kwargs: HookKwargs): Promise<string | null> {
    const parts: string[] = [];
    for (const e of await this.invoke("pre_llm_call", kwargs)) {
      const v = e.value;
      if (typeof v === "string") parts.push(v);
      else if (v && typeof v === "object" && typeof (v as { context?: unknown }).context === "string") {
        parts.push((v as { context: string }).context);
      }
    }
    const nonEmpty = parts.filter((p) => p !== "");
    return nonEmpty.length ? nonEmpty.join("\n\n") : null;
  }

  async preToolCall(kwargs: HookKwargs): Promise<PreToolCallDecision> {
    for (const e of await this.invoke("pre_tool_call", kwargs)) {
      const v = e.value;
      if (v && typeof v === "object" && (v as { action?: unknown }).action === "block") {
        const m = (v as { message?: unknown }).message;
        return { action: "block", message: typeof m === "string" ? m : "blocked by plugin", plugin: e.plugin };
      }
    }
    return { action: "approve" };
  }
}
