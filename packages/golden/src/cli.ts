import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoldenRecord } from "@hermesd/session-actor";
import { BASELINE_FILE, baselineProblems, checkRecords, loadBaseline, summarize, validateFixture } from "./baseline.ts";
import { compareTranscripts, formatDiffs } from "./compare.ts";
import { runScript, serialize } from "./runner.ts";
import { PORT_DIR, UPSTREAM_DIR, loadScript, scriptNames } from "./script.ts";

/**
 * Commands (run from the repository root):
 *
 *   bun packages/golden/src/cli.ts record [name...]         play scripts, write transcripts/port/<name>.json
 *   bun packages/golden/src/cli.ts check [name...]          play scripts, fail if a committed port transcript differs
 *   bun packages/golden/src/cli.ts compare [name...]        apply the policy: upstream transcripts must be valid, and the
 *                                                            differences must be exactly those of transcripts/upstream/expected-differences.json
 *        [--strict]                                           exact parity: no ignore list, no baseline, any difference fails
 *        [--ignore path]...                                   extra field paths to hide from the printed differences (the policy
 *                                                            still judges the full list); with --strict they also count as ignored
 *   bun packages/golden/src/cli.ts baseline [name...]       rewrite expected-differences.json from the current differences
 *   bun packages/golden/src/cli.ts list                     the script names
 */

const [command = "list", ...rest] = process.argv.slice(2);
const names: string[] = [];
const extraIgnore: string[] = [];
let strict = false;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--ignore") extraIgnore.push(rest[++i] ?? "");
  else if (rest[i] === "--strict") strict = true;
  else names.push(rest[i]!);
}
const selected = names.length > 0 ? names : scriptNames();

async function main(): Promise<number> {
  if (command === "list") {
    for (const n of scriptNames()) console.log(`${n}\t${loadScript(n).purpose}`);
    return 0;
  }
  if (command === "record" || command === "check") {
    let bad = 0;
    for (const name of selected) {
      const out = await runScript(loadScript(name));
      const text = serialize(out.record);
      const file = join(PORT_DIR, `${name}.json`);
      if (command === "record") {
        writeFileSync(file, text);
        console.log(`wrote ${file} (${out.record.requests.length} requests)`);
      } else if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
        console.log(`DIFFERS ${name}`);
        bad += 1;
      } else console.log(`same ${name}`);
    }
    return bad > 0 ? 1 : 0;
  }
  if (command === "baseline") {
    const base = loadBaseline();
    const scripts: Record<string, ReturnType<typeof summarize>> = names.length > 0 ? { ...base.scripts } : {};
    for (const name of selected) {
      const upstreamFile = join(UPSTREAM_DIR, `${name}.json`);
      if (!existsSync(upstreamFile)) continue;
      const port = JSON.parse(readFileSync(join(PORT_DIR, `${name}.json`), "utf8")) as GoldenRecord;
      const upstream = JSON.parse(readFileSync(upstreamFile, "utf8")) as GoldenRecord;
      const invalid = [...validateFixture(name, port, "port"), ...validateFixture(name, upstream, "upstream")];
      if (invalid.length > 0) {
        console.log(invalid.join("\n"));
        return 1;
      }
      const diffs = compareTranscripts(port, upstream, { ignore: loadScript(name).upstream.ignore ?? [] });
      if (diffs.length > 0) scripts[name] = summarize(diffs);
      else delete scripts[name];
    }
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ note: base.note, scripts }, null, 2)}\n`);
    console.log(`wrote ${BASELINE_FILE} (${Object.keys(scripts).length} scripts with expected differences)`);
    return 0;
  }
  if (command === "compare") {
    let bad = 0;
    let compared = 0;
    // --strict never reads the baseline, so a missing or malformed file cannot prevent the diagnosis.
    const baseline = strict ? undefined : loadBaseline();
    if (baseline && names.length === 0) {
      for (const p of baselineProblems(baseline, scriptNames())) {
        console.log(`PROBLEM ${p}`);
        bad += 1;
      }
    }
    for (const name of selected) {
      const upstreamFile = join(UPSTREAM_DIR, `${name}.json`);
      if (!existsSync(upstreamFile)) {
        console.log(`skip ${name}: no upstream transcript at ${upstreamFile}`);
        continue;
      }
      compared += 1;
      const port = JSON.parse(readFileSync(join(PORT_DIR, `${name}.json`), "utf8")) as GoldenRecord;
      const upstream = JSON.parse(readFileSync(upstreamFile, "utf8")) as GoldenRecord;
      const scriptIgnore = strict ? [] : (loadScript(name).upstream.ignore ?? []);
      // The policy always sees the script's own ignore list; --ignore only narrows what is printed.
      const policy = baseline ? checkRecords(name, port, upstream, scriptIgnore, baseline) : undefined;
      const invalid = [...validateFixture(name, port, "port"), ...validateFixture(name, upstream, "upstream")];
      if (invalid.length > 0) {
        console.log(`INVALID ${name}\n${invalid.join("\n")}`);
        bad += 1;
        continue;
      }
      const diffs = compareTranscripts(port, upstream, { ignore: [...scriptIgnore, ...extraIgnore] });
      const problems = policy ? policy.problems : diffs.length > 0 ? ["differs"] : [];
      const mark = !policy ? "" : problems.length > 0 ? " [UNEXPECTED]" : diffs.length > 0 || policy.diffs.length > 0 ? " [expected]" : "";
      console.log(diffs.length === 0 && problems.length === 0 ? `same ${name}${mark}` : `DIFFERS ${name}${mark}`);
      if (diffs.length > 0) console.log(formatDiffs(diffs));
      if (policy && problems.length > 0) console.log(`  ${problems.join("\n  ")}`);
      if (problems.length > 0) bad += 1;
    }
    console.log(`${compared} compared, ${bad} ${strict ? "differ" : "failed the policy"}${strict ? "" : " (use --strict for exact parity)"}`);
    return bad > 0 ? 1 : 0;
  }
  console.error(`unknown command: ${command}`);
  return 2;
}

process.exitCode = await main();
