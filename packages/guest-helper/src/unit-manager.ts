import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unitBelongsTo } from "./paths.ts";
import { processMatches, readProcStat } from "./proc.ts";

/** What the manager needs to start the shim of one launch attempt. */
export interface UnitStartSpec {
  unit: string;
  opId: string;
  workspace: string;
  cmd: string;
}

export interface UnitInfo {
  unit: string;
  pid: number | undefined;
  /** Process start time from /proc, in clock ticks. */
  startTime: string | undefined;
}

export interface UnitQuery {
  /** `undefined` when the state cannot be read. Never `false` on a guess. */
  alive: boolean | undefined;
  /** The live units of the op_id. */
  units: UnitInfo[];
}

/** A process the journal recorded: it identifies one process across PID reuse. */
export interface ProcessHint {
  pid: number;
  startTime: string;
}

/**
 * Starts the shim of a launch in its own unit (systemd: a transient unit in
 * its own cgroup; here: a process group) and tells if the units of an
 * op_id are alive. A launch can leave several units for one op_id, so queries
 * go by op_id.
 */
export interface UnitManager {
  readonly kind: string;
  start(spec: UnitStartSpec): Promise<UnitInfo>;
  query(opId: string, hint?: ProcessHint): Promise<UnitQuery>;
  /** Stop every unit of the op_id (cancel). */
  stop(opId: string): Promise<void>;
}

export const SHIM_PATH = fileURLToPath(new URL("./shim.ts", import.meta.url));
export const UNIT_ARG = "--hermesd-unit=";

/** The argv that starts the shim. The unit name is in it, so a process scan can find the unit. */
export function shimArgv(spec: UnitStartSpec): string[] {
  return [process.execPath, SHIM_PATH, `${UNIT_ARG}${spec.unit}`, `--workspace=${spec.workspace}`, `--op=${spec.opId}`, "--", spec.cmd];
}

export interface ProcessGroupOptions {
  /** The workspace directory. Only shims of this workspace count as units. Unit names are global on a host, workspaces are not. */
  workspace: string;
  /**
   * Test only. The start of the shim waits until this file exists. The wait
   * happens in a wrapper that does not carry the unit name, so the unit is
   * invisible meanwhile. This is a model of a start job that waits in the
   * systemd queue (D14 case c).
   */
  queueHoldFile?: string | undefined;
}

const QUEUE_WRAPPER = `
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
const [bin, ...args] = JSON.parse(process.env.HERMESD_QUEUED_ARGV);
const hold = process.env.HERMESD_QUEUE_HOLD_FILE;
const t = setInterval(() => {
  if (!existsSync(hold)) return;
  clearInterval(t);
  const c = spawn(bin, args, { stdio: "ignore" });
  c.on("exit", () => process.exit(0));
}, 20);
`;

/**
 * Unit manager for hosts without systemd. A unit is a detached process group
 * (its own session). It is found by the unit name in the shim's argv, and by
 * PID plus start time when the journal has them. The boot ID is checked by
 * the helper, which compares it with the journal.
 */
export class ProcessGroupUnitManager implements UnitManager {
  readonly kind = "process-group";
  readonly #queueHold: string | undefined;
  readonly #workspace: string;

  constructor(opts: ProcessGroupOptions) {
    this.#queueHold = opts.queueHoldFile;
    this.#workspace = opts.workspace;
  }

  async start(spec: UnitStartSpec): Promise<UnitInfo> {
    const argv = shimArgv(spec);
    let bin = argv[0] as string;
    let args = argv.slice(1);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.#queueHold !== undefined) {
      env.HERMESD_QUEUED_ARGV = JSON.stringify(argv);
      env.HERMESD_QUEUE_HOLD_FILE = this.#queueHold;
      bin = process.execPath;
      args = ["--input-type=module", "-e", QUEUE_WRAPPER];
    }
    const child = spawn(bin, args, { detached: true, stdio: "ignore", cwd: spec.workspace, env });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    child.unref();
    const pid = child.pid;
    return { unit: spec.unit, pid, startTime: pid === undefined ? undefined : readProcStat(pid)?.startTime };
  }

  async query(opId: string, hint?: ProcessHint): Promise<UnitQuery> {
    const units: UnitInfo[] = [];
    try {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (pid === process.pid) continue;
        let argv: string[];
        try {
          argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ESRCH") continue; // the process ended during the scan
          throw e;
        }
        const arg = argv.find((a) => a.startsWith(UNIT_ARG));
        if (arg === undefined) continue;
        const unit = arg.slice(UNIT_ARG.length);
        if (!unitBelongsTo(opId, unit) || !argv.includes(`--workspace=${this.#workspace}`)) continue;
        const st = readProcStat(pid);
        if (st === undefined || st.state === "Z" || st.state === "X") continue;
        units.push({ unit, pid, startTime: st.startTime });
      }
      if (units.length === 0 && hint && processMatches(hint.pid, hint.startTime)) {
        units.push({ unit: "(from journal)", pid: hint.pid, startTime: hint.startTime });
      }
    } catch {
      return { alive: undefined, units: [] };
    }
    return { alive: units.length > 0, units };
  }

  async stop(opId: string): Promise<void> {
    const q = await this.query(opId);
    for (const u of q.units) {
      if (u.pid === undefined) continue;
      try {
        process.kill(-u.pid, "SIGKILL"); // the whole process group
      } catch {
        // already gone
      }
    }
  }
}
