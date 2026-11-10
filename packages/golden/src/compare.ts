import type { GoldenRecord } from "@hermesd/session-actor";

/**
 * The comparator (guide 7.2). It compares a port transcript with an upstream
 * transcript of the same script and lists the differences, each with the request
 * index (or the row) and the field path.
 *
 * Rules:
 * - Request bodies are compared as parsed JSON. The key order does not count
 *   (providers NOTES: the wire key order of upstream is the order of the Python
 *   SDK, which cannot be read statically). The order of arrays does count.
 * - Dates written as YYYY-MM-DD are replaced with `<date>` in every string. The
 *   compaction summary prompt carries the date of the day.
 * - The idempotency key, timestamps, row ids and call ids are not in the format.
 * - `ignore` is a list of field paths. A path matches itself and everything under
 *   it. `[*]` stands for any array index. Example: `requests[*].body.tools`.
 *   Two tokens work on every API mode: `@system` removes the system prompt of each
 *   request (chat: the first message when its role is system or developer; anthropic
 *   and bedrock: `system`; codex: `instructions`), and `@tools` removes the tool
 *   definitions (`tools`, `toolConfig`). The port loop runs with a test system prompt
 *   and three tools, not the ones of Hermes, so these two differ from upstream today.
 *
 * Field paths look like `requests[2].body.messages[1].content` and
 * `rows.messages[3].content`.
 */

export interface Diff {
  /** Where: `request 2`, `messages row 3`, `admissions row 0`, `request count`, `messages row count`. */
  where: string;
  /** The field path inside the record. */
  field: string;
  port: unknown;
  upstream: unknown;
}

export interface CompareOptions {
  ignore?: string[];
}

const ABSENT = Symbol("absent");
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalize(v: unknown): unknown {
  return typeof v === "string" ? v.replace(DATE, "<date>") : v;
}

const tokens = (p: string): string[] => p.match(/\[[^\]]*\]|[^.[\]]+/g) ?? [];

/** Does `path` fall under `pattern`? Both are split in names and `[n]` indexes. `[*]` matches any index. */
export function pathMatches(pattern: string, path: string): boolean {
  const pat = tokens(pattern);
  const got = tokens(path);
  if (pat.length > got.length) return false;
  return pat.every((t, i) => t === got[i] || (t === "[*]" && /^\[\d+\]$/.test(got[i]!)));
}

function walk(a: unknown, b: unknown, path: string, out: Array<{ path: string; port: unknown; upstream: unknown }>): void {
  if (a === ABSENT || b === ABSENT) {
    out.push({ path, port: a === ABSENT ? "<absent>" : a, upstream: b === ABSENT ? "<absent>" : b });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) walk(i < a.length ? a[i] : ABSENT, i < b.length ? b[i] : ABSENT, `${path}[${i}]`, out);
    return;
  }
  if (isObject(a) && isObject(b)) {
    // The order of the port record first, then the keys that only upstream has. Deterministic.
    const keys = [...Object.keys(a), ...Object.keys(b).filter((k) => !(k in a))];
    for (const k of keys) walk(k in a ? a[k] : ABSENT, k in b ? b[k] : ABSENT, path === "" ? k : `${path}.${k}`, out);
    return;
  }
  const x = normalize(a);
  const y = normalize(b);
  if (!Object.is(x, y)) out.push({ path, port: a, upstream: b });
}

function whereOf(path: string): string {
  let m = /^requests\[(\d+)\]/.exec(path);
  if (m) return `request ${m[1]}`;
  m = /^rows\.(messages|admissions)\[(\d+)\]/.exec(path);
  if (m) return `${m[1]} row ${m[2]}`;
  return path;
}

/** Remove the system prompt and/or the tool definitions from a request body, for any API mode. */
function stripBody(body: unknown, system: boolean, tools: boolean): unknown {
  if (!isObject(body)) return body;
  const out: Record<string, unknown> = { ...body };
  if (tools) {
    delete out.tools;
    delete out.toolConfig;
  }
  if (system) {
    delete out.instructions;
    delete out.system;
    const m = out.messages;
    if (Array.isArray(m) && isObject(m[0]) && (m[0].role === "system" || m[0].role === "developer")) out.messages = m.slice(1);
  }
  return out;
}

export function compareTranscripts(port: GoldenRecord, upstream: GoldenRecord, opts: CompareOptions = {}): Diff[] {
  const system = (opts.ignore ?? []).includes("@system");
  const tools = (opts.ignore ?? []).includes("@tools");
  const ignore = (opts.ignore ?? []).filter((p) => !p.startsWith("@"));
  // The index of a request is its place in the list. It is not compared as a field.
  const strip = (r: GoldenRecord): unknown => ({
    requests: r.requests.map(({ index: _index, body, ...rest }) => ({ ...rest, body: stripBody(body, system, tools) })),
    rows: r.rows,
  });
  const raw: Array<{ path: string; port: unknown; upstream: unknown }> = [];
  walk(strip(port), strip(upstream), "", raw);
  const diffs: Diff[] = [];
  const counts: Array<[string, number, number]> = [
    ["request count", port.requests.length, upstream.requests.length],
    ["messages row count", port.rows.messages.length, upstream.rows.messages.length],
    ["admissions row count", port.rows.admissions.length, upstream.rows.admissions.length],
  ];
  for (const [where, p, u] of counts) if (p !== u) diffs.push({ where, field: "", port: p, upstream: u });
  for (const d of raw) {
    if (ignore.some((pattern) => pathMatches(pattern, d.path))) continue;
    diffs.push({ where: whereOf(d.path), field: d.path, port: d.port, upstream: d.upstream });
  }
  return diffs;
}

function show(v: unknown): string {
  const text = typeof v === "string" ? JSON.stringify(v) : v === undefined ? "undefined" : JSON.stringify(v);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** One block per difference: where, the field, and both values. */
export function formatDiffs(diffs: Diff[]): string {
  if (diffs.length === 0) return "no differences";
  return diffs
    .map((d) => `${d.where}${d.field ? `: ${d.field}` : ""}\n  port:     ${show(d.port)}\n  upstream: ${show(d.upstream)}`)
    .join("\n");
}
