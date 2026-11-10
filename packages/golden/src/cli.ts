import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoldenRecord } from "@hermesd/session-actor";
import { compareTranscripts, formatDiffs } from "./compare.ts";
import { runScript, serialize } from "./runner.ts";
import { PORT_DIR, UPSTREAM_DIR, loadScript, scriptNames } from "./script.ts";

/**
 * Commands (run from the repository root):
 *
 *   node packages/golden/src/cli.ts record [name...]         play scripts, write transcripts/port/<name>.json
 *   node packages/golden/src/cli.ts check [name...]          play scripts, fail if a committed port transcript differs
 *   node packages/golden/src/cli.ts compare [name...]        diff port and upstream transcripts
 *        [--ignore path]...                                   extra field paths to ignore
 *        [--strict]                                           do not use the ignore list of the script
 *   node packages/golden/src/cli.ts list                     the script names
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
  if (command === "compare") {
    let bad = 0;
    let compared = 0;
    for (const name of selected) {
      const upstreamFile = join(UPSTREAM_DIR, `${name}.json`);
      if (!existsSync(upstreamFile)) {
        console.log(`skip ${name}: no upstream transcript at ${upstreamFile}`);
        continue;
      }
      const port = JSON.parse(readFileSync(join(PORT_DIR, `${name}.json`), "utf8")) as GoldenRecord;
      const upstream = JSON.parse(readFileSync(upstreamFile, "utf8")) as GoldenRecord;
      const diffs = compareTranscripts(port, upstream, { ignore: [...(strict ? [] : (loadScript(name).upstream.ignore ?? [])), ...extraIgnore] });
      compared += 1;
      console.log(diffs.length === 0 ? `same ${name}` : `DIFFERS ${name}\n${formatDiffs(diffs)}`);
      if (diffs.length > 0) bad += 1;
    }
    console.log(`${compared} compared, ${bad} differ`);
    return bad > 0 ? 1 : 0;
  }
  console.error(`unknown command: ${command}`);
  return 2;
}

process.exitCode = await main();
