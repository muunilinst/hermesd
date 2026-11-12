import { join } from "node:path";

/** The on-disk layout under the workspace directory. */
export interface Layout {
  root: string;
  journal: string;
  claimsDir: string;
  opsDir: string;
  claim(opId: string): string;
  opDir(opId: string): string;
  exit(opId: string): string;
  stdout(opId: string): string;
  stderr(opId: string): string;
  /** A diagnostic marker that a losing shim leaves. It is not evidence. */
  lost(opId: string, unit: string): string;
}

export function layout(workspace: string): Layout {
  const root = join(workspace, ".hermesd-guest");
  const claimsDir = join(root, "claims");
  const opsDir = join(root, "ops");
  return {
    root,
    journal: join(root, "journal.log"),
    claimsDir,
    opsDir,
    claim: (opId) => join(claimsDir, opId),
    opDir: (opId) => join(opsDir, opId),
    exit: (opId) => join(opsDir, opId, "exit.json"),
    stdout: (opId) => join(opsDir, opId, "stdout"),
    stderr: (opId) => join(opsDir, opId, "stderr"),
    lost: (opId, unit) => join(opsDir, opId, `lost-${unit}`),
  };
}

const OP_ID = /^[A-Za-z0-9_-]{1,160}$/;

/** An op_id becomes a file name and a unit name, so it must be plain. */
export function assertOpId(opId: string): void {
  if (!OP_ID.test(opId)) throw new TypeError(`invalid op_id: ${JSON.stringify(opId)}`);
}

/** The unit for launch attempt `attempt` of an operation. */
export function unitName(opId: string, attempt: number): string {
  return `hermesd-op-${opId}-${attempt}`;
}

/** Tell if a unit name belongs to the operation, whatever its attempt number. */
export function unitBelongsTo(opId: string, unit: string): boolean {
  const p = `hermesd-op-${opId}-`;
  return unit.startsWith(p) && /^\d+$/.test(unit.slice(p.length));
}
