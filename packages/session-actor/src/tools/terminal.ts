import type { Command, CommandResult } from "@hermesd/executor-protocol";

/**
 * The terminal tool. It has no subprocess: it prepares and starts an
 * operation on the executor and waits for the result (guide 6.5).
 */

export type BuildCommand = (args: TerminalArgs) => Command;

export interface TerminalArgs {
  command: string;
  background?: boolean;
  timeout?: number;
  workdir?: string;
  pty?: boolean;
}

export function parseTerminal(args: unknown): TerminalArgs | string {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (typeof a.command !== "string" || a.command === "") return "terminal needs a non-empty `command` string";
  const out: TerminalArgs = { command: a.command };
  if (typeof a.background === "boolean") out.background = a.background;
  if (typeof a.timeout === "number") out.timeout = a.timeout;
  if (typeof a.workdir === "string") out.workdir = a.workdir;
  if (typeof a.pty === "boolean") out.pty = a.pty;
  return out;
}

/** The default command: run the string in a shell. */
export const shellCommand: BuildCommand = (args) => ({
  argv: ["bash", "-lc", args.command],
  ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
});

/** A stable string for hashing: keys in sorted order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The hash of the command input. A different hash for one op_id is a conflict at the executor. */
export async function inputHash(cmd: Command): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(cmd)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The tool result for a finished command, in upstream's shape. */
export function terminalResult(r: CommandResult | undefined, failed: boolean): string {
  if (!r) return JSON.stringify({ output: "", exit_code: failed ? -1 : 0, error: failed ? "the command failed" : null });
  const output = r.stderr ? `${r.stdout}${r.stdout && !r.stdout.endsWith("\n") ? "\n" : ""}${r.stderr}` : r.stdout;
  return JSON.stringify({ output, exit_code: r.exitCode, error: null });
}
