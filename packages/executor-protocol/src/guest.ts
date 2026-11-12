/**
 * The guest launch boundary (porting guide rev 5.1, section 3.4).
 *
 * The guest helper writes a launch journal on the workspace disk. A shim
 * creates a claim file with O_CREAT | O_EXCL before it runs the command.
 * The claim is the exclusion: exactly one shim can create it, so a command
 * runs at most once.
 *
 * Status: specified, not demonstrated. Fault tests D14 (a) to (d), D15 and
 * D16 decide it.
 */

/** What the helper reports for one op_id after reconciliation. */
export type LaunchStatus =
  /** The command has not run. Launching again with the same op_id is permitted. */
  | "not_launched"
  /** The shim exists and has not claimed yet. Adopt it and wait. Do not launch again. */
  | "starting"
  /** Claim file and a live unit. Adopt it. */
  | "running"
  | "done"
  | "failed"
  /** The command may have run and its end is not known, or the state cannot be read. */
  | "unknown";

/** The facts that reconciliation reads for one journal entry. */
export interface LaunchEvidence {
  /** The journal entry was written in an older boot. */
  olderBoot: boolean;
  claimFile: boolean;
  /** `undefined` when the unit state cannot be read. */
  unitAlive: boolean | undefined;
  exitStatusWritten: boolean;
  /** Only meaningful when `exitStatusWritten` is true. */
  exitCode?: number;
}

/**
 * The reconciliation table of section 3.4, as a pure function.
 *
 * The helper applies it to every journal entry that has no final status,
 * after a helper restart or a VM boot. It never answers `not_launched` on a
 * guess: when the launch cannot be established, the answer is `unknown`.
 */
export function reconcileLaunch(e: LaunchEvidence): LaunchStatus {
  if (e.exitStatusWritten) {
    return e.exitCode === 0 ? "done" : "failed";
  }
  if (e.olderBoot) {
    // No shim of an older boot can still start.
    return e.claimFile ? "unknown" : "not_launched";
  }
  if (e.unitAlive === undefined) {
    // A claim file without an exit status and an unreadable unit is also unknown.
    return "unknown";
  }
  if (e.claimFile) {
    return e.unitAlive ? "running" : "unknown";
  }
  return e.unitAlive ? "starting" : "not_launched";
}
