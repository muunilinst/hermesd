/**
 * The shim: the first process of a launch unit (porting guide rev 5.1, 3.4).
 *
 * Usage: node shim.ts --hermesd-unit=<unit> --workspace=<dir> --op=<op_id> -- <cmd>
 *
 * 1. Create the claim file for the op_id with O_CREAT | O_EXCL, sync the file
 *    and its directory. If the file exists, exit at once and run nothing.
 * 2. Only then run the command (with `sh -c`).
 * 3. Wait for it, write the output files, write the exit status, exit.
 *
 * The shim has no other state. It is plain Node and uses only synchronous
 * file calls before the command starts, so it ports to a small Rust program.
 *
 * Test-only: when HERMESD_TEST_SHIM_HOLD_FILE is set, the shim writes
 * "<file>.reached" and waits for <file> to exist before it claims.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createExclusiveDurable, fsyncPath, mkdirpDurable, sleepSync, writeFileAtomicDurable } from "./fsutil.ts";
import { layout } from "./paths.ts";
import { readKernelBootId, readProcStat } from "./proc.ts";

function arg(name: string): string {
  const prefix = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(prefix));
  if (a === undefined) throw new Error(`missing --${name}`);
  return a.slice(prefix.length);
}

const unit = arg("hermesd-unit");
const workspace = arg("workspace");
const opId = arg("op");
const sep = process.argv.indexOf("--");
const cmd = sep >= 0 ? process.argv[sep + 1] : undefined;
if (cmd === undefined) throw new Error("missing command");

const L = layout(workspace);
mkdirpDurable(L.claimsDir);
mkdirpDurable(L.opDir(opId));

const hold = process.env.HERMESD_TEST_SHIM_HOLD_FILE;
if (hold) {
  fs.writeFileSync(`${hold}.reached`, unit);
  while (!fs.existsSync(hold)) sleepSync(10);
}

try {
  createExclusiveDurable(
    L.claim(opId),
    JSON.stringify({
      unit,
      pid: process.pid,
      startTime: readProcStat(process.pid)?.startTime,
      bootId: readKernelBootId(),
    }),
  );
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === "EEXIST") {
    // Another shim holds the claim. Run nothing.
    try {
      fs.writeFileSync(L.lost(opId, unit), "");
    } catch {
      // diagnostic only
    }
    process.exit(0);
  }
  throw e;
}

// The claim is durable. From here the command may run.
const out = fs.openSync(L.stdout(opId), "w");
const err = fs.openSync(L.stderr(opId), "w");
const child = spawn("/bin/sh", ["-c", cmd], { stdio: ["ignore", out, err] });
let finished = false;
const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
  if (finished) return;
  finished = true;
  fs.fsyncSync(out);
  fs.fsyncSync(err);
  fsyncPath(L.opDir(opId));
  writeFileAtomicDurable(L.exit(opId), JSON.stringify({ code, signal, unit, bootId: readKernelBootId() }));
  process.exit(0);
};
child.on("error", () => finish(127, null));
child.on("exit", (code, signal) => finish(code, signal));
