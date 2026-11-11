/**
 * Helpers for tests that use real child processes and real files.
 * No test framework code here, so any package can use it.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HelperResponse } from "./helper.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

export interface HelperRun {
  exitCode: number | null;
  /** "SIGKILL" when a fault point killed the helper. */
  signal: NodeJS.Signals | null;
  /** The parsed answer; undefined when the helper died before it answered. */
  answer: unknown;
  stderr: string;
}

/** Run the guest helper as a child process and wait for it to end. */
export function runHelper(workspace: string, args: string[], env: Record<string, string> = {}): Promise<HelperRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, workspace, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HERMESD_UNIT_MANAGER: "process", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      const line = out.trim().split("\n").at(-1);
      resolve({ exitCode, signal, answer: line ? JSON.parse(line) : undefined, stderr: err });
    });
  });
}

/** `launch` as a helper process; the answer is typed. */
export async function launchVia(workspace: string, opId: string, cmd: string, env: Record<string, string> = {}, incarnation = 1) {
  const run = await runHelper(workspace, ["launch", opId, String(incarnation), cmd], env);
  return { ...run, response: run.answer as HelperResponse | undefined };
}

export async function statusVia(workspace: string, opId: string, env: Record<string, string> = {}) {
  const run = await runHelper(workspace, ["status", opId], env);
  return { ...run, response: run.answer as HelperResponse | undefined };
}

export function makeTempDir(prefix = "hermesd-guest-"): string {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

/** Poll until `pred` is true. Fails with `what` after `timeoutMs`. */
export async function waitFor(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Quote a string for `sh`. */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * A command that increments a counter: it appends one line to `counter`.
 * With `gate`, it then waits until the file `gate` exists. "One run" means the
 * counter has one line. The command itself writes the count; nothing else does.
 */
export function countingCommand(counter: string, gate?: string): string {
  const base = `echo run >> ${shq(counter)}`;
  return gate === undefined ? base : `${base}; while [ ! -e ${shq(gate)} ]; do sleep 0.02; done`;
}

/** How many times the command ran. */
export function readCounter(counter: string): number {
  try {
    return fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}

/** Kill every process whose command line mentions the workspace. Repeats until none is left. */
export function killWorkspaceProcesses(workspace: string): void {
  for (let pass = 0; pass < 50; pass++) {
    let found = false;
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        const cmdline = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
        if (!cmdline.includes(`--workspace=${workspace}`)) continue;
        found = true;
        try {
          process.kill(-Number(name), "SIGKILL");
        } catch {
          process.kill(Number(name), "SIGKILL");
        }
      } catch {
        // the process ended
      }
    }
    if (!found) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

/** Read the journal as parsed records. */
export function readJournal(workspace: string): Array<Record<string, unknown>> {
  const p = join(workspace, ".hermesd-guest", "journal.log");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * The skip option of a test that needs Linux: the helper reads /proc and the
 * kernel boot ID. On another system such a test is skipped with this reason,
 * so a full run there still finishes and reports.
 */
export const needsLinux: string | false = process.platform === "linux" ? false : "needs Linux (/proc, the kernel boot ID)";
