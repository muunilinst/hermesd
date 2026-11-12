import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { unitBelongsTo } from "./paths.ts";
import { readProcStat } from "./proc.ts";
import { shimArgv, type ProcessHint, type UnitInfo, type UnitManager, type UnitQuery, type UnitStartSpec } from "./unit-manager.ts";

const execFileP = promisify(execFile);

/**
 * True when systemd is PID 1. The check is the `comm` of PID 1 and the
 * runtime directory that systemd creates at boot. Containers whose PID 1 is
 * another program give false.
 */
export function isSystemdPid1(
  readComm: () => string = () => readFileSync("/proc/1/comm", "utf8"),
  runtimeDirExists: () => boolean = () => existsSync("/run/systemd/system"),
): boolean {
  try {
    return readComm().trim() === "systemd" && runtimeDirExists();
  } catch {
    return false;
  }
}

/**
 * Arguments for `systemd-run`. A service (not a scope) is used because
 * `--scope` runs the command in the foreground of systemd-run itself, which
 * the helper must not wait for. KillMode=control-group makes a stop kill the
 * whole cgroup. `--collect` removes the unit after it ends, also after a
 * failure, so a finished unit is "not found" and not "failed".
 */
export function buildSystemdRunArgs(spec: UnitStartSpec): string[] {
  const [bin, ...rest] = shimArgv(spec);
  return [
    `--unit=${spec.unit}`,
    "--quiet",
    "--collect",
    `--description=hermesd operation ${spec.opId}`,
    "--property=KillMode=control-group",
    `--working-directory=${spec.workspace}`,
    "--",
    bin as string,
    ...rest,
  ];
}

const LIVE_STATES = new Set(["active", "activating", "reloading", "deactivating"]);

/** Parse `systemctl list-units --plain --no-legend` output: unit names with an active state. */
export function parseListUnits(out: string): { unit: string; active: string }[] {
  const res: { unit: string; active: string }[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    // Columns: UNIT LOAD ACTIVE SUB DESCRIPTION...
    if (cols.length < 4 || cols[0] === undefined || cols[2] === undefined) continue;
    res.push({ unit: cols[0].replace(/\.service$/, ""), active: cols[2] });
  }
  return res;
}

/** Parse `systemctl show -p ...` output (key=value lines). */
export function parseShow(out: string): Record<string, string> {
  const res: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) res[line.slice(0, i)] = line.slice(i + 1);
  }
  return res;
}

/** The transient-unit manager for a guest where systemd is PID 1. */
export class SystemdUnitManager implements UnitManager {
  readonly kind = "systemd";

  async start(spec: UnitStartSpec): Promise<UnitInfo> {
    await execFileP("systemd-run", buildSystemdRunArgs(spec));
    const { stdout } = await execFileP("systemctl", ["show", "-p", "MainPID", `${spec.unit}.service`]);
    const pid = Number(parseShow(stdout).MainPID ?? 0) || undefined;
    return { unit: spec.unit, pid, startTime: pid === undefined ? undefined : readProcStat(pid)?.startTime };
  }

  async query(opId: string, _hint?: ProcessHint): Promise<UnitQuery> {
    // The liveness source is systemd, not the PID: a cgroup stays known to systemd as long as it has a process.
    try {
      const { stdout } = await execFileP("systemctl", [
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        "--no-pager",
        "--type=service",
        `hermesd-op-${opId}-*.service`,
      ]);
      const units: UnitInfo[] = [];
      for (const u of parseListUnits(stdout)) {
        if (!unitBelongsTo(opId, u.unit) || !LIVE_STATES.has(u.active)) continue;
        const { stdout: show } = await execFileP("systemctl", ["show", "-p", "MainPID", `${u.unit}.service`]);
        const pid = Number(parseShow(show).MainPID ?? 0) || undefined;
        units.push({ unit: u.unit, pid, startTime: pid === undefined ? undefined : readProcStat(pid)?.startTime });
      }
      return { alive: units.length > 0, units };
    } catch {
      return { alive: undefined, units: [] };
    }
  }

  async stop(opId: string): Promise<void> {
    const q = await this.query(opId);
    for (const u of q.units) await execFileP("systemctl", ["stop", `${u.unit}.service`]);
  }
}
