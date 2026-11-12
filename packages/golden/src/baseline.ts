import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN_FORMAT, type GoldenRecord } from "@hermesd/session-actor";
import { compareTranscripts, type Diff } from "./compare.ts";
import { PORT_DIR, UPSTREAM_DIR, loadScript } from "./script.ts";

/**
 * The expected-differences baseline (transcripts/upstream/expected-differences.json).
 *
 * Each upstream transcript that is recorded but not yet triaged has an entry: how many differences
 * the comparator finds (with the script's own ignore list), which fields they are in, and a digest
 * of the full difference list (field, port value and upstream value of each). The policy is:
 *
 * - a script with an entry must produce exactly that entry; a difference that vanished, a new one and a
 *   changed value all fail, so a new regression cannot hide behind an old mismatch;
 * - a script without an entry must agree with upstream;
 * - an entry for a script without an upstream transcript fails;
 * - every upstream transcript must have the right script, side and format, and real content.
 *
 * The unit test and `cli.ts compare` use this module. `compare --strict` ignores it and wants no difference.
 */

export interface BaselineEntry {
  diffCount: number;
  /** Sorted, unique field paths of the differences (`where` for a count difference). */
  fields: string[];
  /** sha256 of the difference list as JSON. */
  digest: string;
}

export interface Baseline {
  note: string;
  scripts: Record<string, BaselineEntry>;
}

export const BASELINE_FILE = join(UPSTREAM_DIR, "expected-differences.json");

export function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
}

export function summarize(diffs: Diff[]): BaselineEntry {
  const fields = [...new Set(diffs.map((d) => d.field || d.where))].sort();
  const digest = createHash("sha256").update(JSON.stringify(diffs.map((d) => [d.where, d.field, d.port, d.upstream]))).digest("hex");
  return { diffCount: diffs.length, fields, digest };
}

/** Problems with a recorded transcript that make a comparison meaningless. Empty when it is usable. */
export function validateFixture(name: string, rec: unknown, side: "port" | "upstream"): string[] {
  const p: string[] = [];
  const r = rec as Partial<GoldenRecord> | null;
  if (typeof r !== "object" || r === null) return [`${side} ${name}: not an object`];
  if (r.format !== GOLDEN_FORMAT) p.push(`${side} ${name}: format ${JSON.stringify(r.format)}, wanted ${GOLDEN_FORMAT}`);
  if (r.side !== side) p.push(`${side} ${name}: side ${JSON.stringify(r.side)}`);
  if (r.script !== name) p.push(`${side} ${name}: records script ${JSON.stringify(r.script)}`);
  if (!Array.isArray(r.requests) || r.requests.length === 0) p.push(`${side} ${name}: no requests`);
  const rows = r.rows;
  if (!rows || !Array.isArray(rows.messages) || rows.messages.length === 0) p.push(`${side} ${name}: no messages rows`);
  if (!rows || !Array.isArray(rows.admissions) || rows.admissions.length === 0) p.push(`${side} ${name}: no admissions rows`);
  return p;
}

export interface Checked {
  problems: string[];
  diffs: Diff[];
  summary?: BaselineEntry;
}

/** Apply the policy to a pair of transcripts of one script. */
export function checkRecords(name: string, port: unknown, upstream: unknown, ignore: string[], baseline: Baseline): Checked {
  const problems = [...validateFixture(name, port, "port"), ...validateFixture(name, upstream, "upstream")];
  if (problems.length > 0) return { problems, diffs: [] };
  const diffs = compareTranscripts(port as GoldenRecord, upstream as GoldenRecord, { ignore });
  const summary = summarize(diffs);
  const want = baseline.scripts[name];
  if (!want) {
    if (diffs.length > 0) problems.push(`${name}: ${diffs.length} difference(s) from upstream that expected-differences.json does not list`);
  } else if (diffs.length === 0) {
    problems.push(`${name} now agrees with upstream: remove it from transcripts/upstream/expected-differences.json`);
  } else if (want.digest !== summary.digest) {
    const gone = want.fields.filter((f) => !summary.fields.includes(f));
    const added = summary.fields.filter((f) => !want.fields.includes(f));
    problems.push(
      `${name}: the differences changed from the baseline (count ${want.diffCount} -> ${summary.diffCount}` +
        `${added.length ? `; new fields: ${added.join(", ")}` : ""}${gone.length ? `; vanished fields: ${gone.join(", ")}` : ""}` +
        `${!added.length && !gone.length ? "; same fields, different values" : ""}). ` +
        `If intended, run: bun packages/golden/src/cli.ts baseline`,
    );
  }
  return { problems, diffs, summary };
}

/** Apply the policy to one script that has an upstream transcript on disk. */
export function checkAgainstBaseline(name: string, baseline: Baseline): Checked {
  const port = JSON.parse(readFileSync(join(PORT_DIR, `${name}.json`), "utf8")) as unknown;
  const upstream = JSON.parse(readFileSync(join(UPSTREAM_DIR, `${name}.json`), "utf8")) as unknown;
  return checkRecords(name, port, upstream, loadScript(name).upstream.ignore ?? [], baseline);
}

/** Baseline entries for unknown scripts or scripts without an upstream transcript. */
export function baselineProblems(baseline: Baseline, scripts: string[]): string[] {
  const p: string[] = [];
  for (const n of Object.keys(baseline.scripts)) {
    if (!scripts.includes(n)) p.push(`expected-differences.json names ${n}, which is not a script`);
    else if (!existsSync(join(UPSTREAM_DIR, `${n}.json`))) p.push(`expected-differences.json lists ${n} but transcripts/upstream/${n}.json is missing`);
  }
  return p;
}
