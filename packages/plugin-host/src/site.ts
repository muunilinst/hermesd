/**
 * Call-site flags and shadow mode (porting guide, section 9.1).
 *
 * Every tool, hook and adapter is a call site. Each has one flag: python,
 * shadow or ts. The flags are plain data, so they can change without a deploy.
 *
 * Shadow mode has two forms:
 *  - Live shadow, for pure sites. Both sides run on the real input. The
 *    TypeScript side gets an Effects object that throws, so a "pure" site that
 *    tries an effect is caught.
 *  - Replay shadow, for effectful sites. Only the Python side runs live. Its
 *    input and every outbound call it made are recorded. TypeScript runs later
 *    against the record, with the outbound calls mocked. The comparison is on
 *    the requests TypeScript would have made.
 *
 * The manifest marks a site pure. An unmarked site is effectful.
 * Exactly one implementation dispatches a real effect.
 */

export type SiteKind = "tool" | "hook" | "adapter";
export type SiteMode = "python" | "shadow" | "ts";
export type SiteEffect = "pure" | "effectful";

export interface SiteFlag {
  kind: SiteKind;
  name: string;
  mode: SiteMode;
  effect: SiteEffect;
}

export function siteKey(kind: SiteKind, name: string): string {
  return `${kind}:${name}`;
}

const MODES: readonly string[] = ["python", "shadow", "ts"];
const KINDS: readonly string[] = ["tool", "hook", "adapter"];

export class FlagStore {
  readonly #flags = new Map<string, SiteFlag>();

  /** Add a site. `pure: true` is the only way to get a pure site. */
  declare(kind: SiteKind, name: string, opts: { pure?: boolean } = {}): SiteFlag {
    const key = siteKey(kind, name);
    const effect: SiteEffect = opts.pure === true ? "pure" : "effectful";
    const flag: SiteFlag = { kind, name, mode: this.#flags.get(key)?.mode ?? "python", effect };
    this.#flags.set(key, flag);
    return { ...flag };
  }

  setMode(kind: SiteKind, name: string, mode: SiteMode): void {
    if (!MODES.includes(mode)) throw new TypeError(`bad mode ${mode}`);
    const cur = this.get(kind, name);
    this.#flags.set(siteKey(kind, name), { ...cur, mode });
  }

  /** An unknown site is python and effectful: the safe default. */
  get(kind: SiteKind, name: string): SiteFlag {
    const f = this.#flags.get(siteKey(kind, name));
    return f ? { ...f } : { kind, name, mode: "python", effect: "effectful" };
  }

  toJSON(): SiteFlag[] {
    return [...this.#flags.values()].map((f) => ({ ...f }));
  }

  static fromJSON(rows: unknown): FlagStore {
    const store = new FlagStore();
    if (!Array.isArray(rows)) throw new TypeError("flag rows must be a list");
    for (const r of rows as Record<string, unknown>[]) {
      if (!KINDS.includes(r["kind"] as string) || !MODES.includes(r["mode"] as string) || typeof r["name"] !== "string") {
        throw new TypeError(`bad flag row ${JSON.stringify(r)}`);
      }
      store.#flags.set(siteKey(r["kind"] as SiteKind, r["name"]), {
        kind: r["kind"] as SiteKind,
        name: r["name"],
        mode: r["mode"] as SiteMode,
        // Anything but "pure" is effectful.
        effect: r["effect"] === "pure" ? "pure" : "effectful",
      });
    }
    return store;
  }
}

/** One outbound call that a site made. */
export interface EffectCall {
  name: string;
  request: unknown;
  response: unknown;
}

export interface Effects {
  call(name: string, request: unknown): Promise<unknown>;
}

export class EffectForbiddenError extends Error {
  constructor(name: string) {
    super(`effect "${name}" is not allowed here`);
    this.name = "EffectForbiddenError";
  }
}

export class ReplayMissError extends Error {
  constructor(name: string, index: number) {
    super(`replay has no recorded response for call ${index} ("${name}")`);
    this.name = "ReplayMissError";
  }
}

export const forbiddenEffects: Effects = {
  call(name) {
    return Promise.reject(new EffectForbiddenError(name));
  },
};

export interface PythonOutcome<O> {
  result: O;
  /** The outbound calls the Python side made, with their responses. */
  calls: EffectCall[];
}

export interface SiteImpls<I, O> {
  /** Runs the Python side. It does its own real effects and reports them. */
  python(input: I, signal?: AbortSignal): Promise<PythonOutcome<O>>;
  /** Runs the TypeScript side. Real effects only go through `fx`. */
  ts(input: I, fx: Effects): Promise<O>;
}

export interface Recording<I = unknown, O = unknown> {
  site: string;
  input: I;
  calls: EffectCall[];
  result: O;
}

export interface Diff {
  path: string;
  python: unknown;
  ts: unknown;
}

/** Compare two JSON-like values. Returns one entry for each difference. */
export function diffValues(python: unknown, ts: unknown, path = ""): Diff[] {
  if (Object.is(python, ts)) return [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  if (!isObj(python) || !isObj(ts)) return [{ path: path || "$", python, ts }];
  if (Array.isArray(python) !== Array.isArray(ts)) return [{ path: path || "$", python, ts }];
  const out: Diff[] = [];
  const keys = new Set([...Object.keys(python), ...Object.keys(ts)]);
  for (const k of keys) {
    const sub = `${path}${Array.isArray(python) ? `[${k}]` : `.${k}`}`;
    if (!(k in python) || !(k in ts)) out.push({ path: sub, python: python[k], ts: ts[k] });
    else out.push(...diffValues(python[k], ts[k], sub));
  }
  return out;
}

export interface SiteContext {
  flags: FlagStore;
  /** The one object that dispatches real effects when the site is `ts`. */
  realEffects: Effects;
  /** Replay shadow appends here. */
  recordings: Recording[];
  /** Called with the diffs of a live shadow run that found any. */
  onDiff?: (site: string, diffs: Diff[]) => void;
}

export interface SiteRun<O> {
  served: "python" | "ts";
  result: O;
  /** Live shadow only: differences found now. */
  diffs: Diff[];
  /** True if a replay record was stored. */
  recorded: boolean;
}

/** Run a call site in the mode its flag says. */
export async function runSite<I, O>(
  kind: SiteKind,
  name: string,
  input: I,
  impls: SiteImpls<I, O>,
  ctx: SiteContext,
  signal?: AbortSignal,
): Promise<SiteRun<O>> {
  const flag = ctx.flags.get(kind, name);
  const site = siteKey(kind, name);
  if (flag.mode === "ts") {
    return { served: "ts", result: await impls.ts(input, ctx.realEffects), diffs: [], recorded: false };
  }
  const py = await impls.python(input, signal);
  if (flag.mode === "python") return { served: "python", result: py.result, diffs: [], recorded: false };
  // Shadow.
  if (flag.effect === "pure") {
    let diffs: Diff[];
    try {
      diffs = diffValues(py.result, await impls.ts(input, forbiddenEffects));
    } catch (err) {
      diffs = [{ path: "$thrown", python: undefined, ts: String(err) }];
    }
    if (diffs.length) ctx.onDiff?.(site, diffs);
    return { served: "python", result: py.result, diffs, recorded: false };
  }
  // Effectful: record, and do not run TypeScript now.
  ctx.recordings.push({ site, input, calls: py.calls, result: py.result });
  return { served: "python", result: py.result, diffs: [], recorded: true };
}

export interface ReplayReport {
  site: string;
  /** Requests TypeScript made, in order. */
  requests: { name: string; request: unknown }[];
  /** Differences between the recorded Python requests and the TS requests. */
  diffs: Diff[];
  /** Difference between the two results. Reported, but not the main test. */
  resultDiffs: Diff[];
}

/**
 * Replay shadow, second half. Run the TypeScript handler on a recorded input.
 * Its outbound calls get the recorded responses in order. Nothing is sent.
 */
export async function replayRecording<I, O>(
  rec: Recording<I, O>,
  ts: (input: I, fx: Effects) => Promise<O>,
): Promise<ReplayReport> {
  const requests: { name: string; request: unknown }[] = [];
  const mock: Effects = {
    async call(name, request) {
      const i = requests.length;
      requests.push({ name, request });
      const recorded = rec.calls[i];
      if (!recorded) throw new ReplayMissError(name, i);
      return recorded.response;
    },
  };
  let resultDiffs: Diff[];
  try {
    resultDiffs = diffValues(rec.result, await ts(rec.input, mock));
  } catch (err) {
    resultDiffs = [{ path: "$thrown", python: undefined, ts: String(err) }];
  }
  const diffs = diffValues(
    rec.calls.map((c) => ({ name: c.name, request: c.request })),
    requests,
  );
  return { site: rec.site, requests, diffs, resultDiffs };
}
