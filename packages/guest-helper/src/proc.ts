import { readFileSync } from "node:fs";

/** The boot ID of the running kernel. Tests replace it to simulate a reboot. */
export type BootIdSource = () => string;

export const readKernelBootId: BootIdSource = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

export interface ProcStat {
  /** Process state letter, for example "R", "S" or "Z". */
  state: string;
  /** Start time in clock ticks since boot (field 22). With the PID and the boot ID it names one process. */
  startTime: string;
}

/**
 * Parse /proc/<pid>/stat. The command name is in parentheses and can contain
 * spaces and parentheses, so the parser splits after the last ")".
 */
export function parseProcStat(text: string): ProcStat {
  const close = text.lastIndexOf(")");
  if (close < 0) throw new Error("bad /proc stat");
  const rest = text.slice(close + 2).split(" ");
  // rest[0] is field 3 (state); field 22 (starttime) is rest[19].
  const state = rest[0];
  const startTime = rest[19];
  if (state === undefined || startTime === undefined) throw new Error("short /proc stat");
  return { state, startTime };
}

/** Read the stat of a process. Returns undefined when the process does not exist. */
export function readProcStat(pid: number): ProcStat | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw e;
  }
  return parseProcStat(text);
}

/** True when the process exists, is not a zombie, and has the recorded start time. */
export function processMatches(pid: number, startTime: string): boolean {
  const s = readProcStat(pid);
  return s !== undefined && s.state !== "Z" && s.state !== "X" && s.startTime === startTime;
}
