/**
 * The executor contract (porting guide rev 5.1, section 3.4).
 *
 * Status: specified, not demonstrated. Fault tests D2, D4, D5, D10, D11 and
 * D13 to D17 decide it.
 */

/** A stable operation ID, derived from the intent. See `deriveOpId`. */
export type OpId = string & { readonly __brand: "OpId" };

/** The workspace incarnation. It only increases, also after a restore. */
export type Incarnation = number;

/** The owner epoch of the caller. It is never part of the op_id. */
export type OwnerEpoch = number;

/** The result of a finished command. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The command that an operation runs. */
export interface Command {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Every status that `status(op_id)` can return. */
export const OP_STATUSES = [
  "prepared",
  "dispatching",
  "running",
  "done",
  "failed",
  "cancelled",
  "unknown",
  "expired",
] as const;

export type OpStatusName = (typeof OP_STATUSES)[number];

export type OpStatus =
  | { status: "prepared" }
  | { status: "dispatching" }
  | { status: "running" }
  | { status: "done"; result: CommandResult }
  | { status: "failed"; result?: CommandResult; reason?: string }
  | { status: "cancelled" }
  | { status: "unknown" }
  | { status: "expired" };

/** A terminal status does not change again. */
export const TERMINAL_STATUSES: ReadonlySet<OpStatusName> = new Set([
  "done",
  "failed",
  "cancelled",
  "unknown",
  "expired",
]);

export function isTerminal(status: OpStatusName): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface PrepareRequest {
  opId: OpId;
  intentId: string;
  /** The incarnation that the session actor read with `describe` and stored. */
  incarnation: Incarnation;
  /** A hash of the command input. A different hash for one op_id is a conflict. */
  inputHash: string;
  cmd: Command;
}

export type PrepareResponse =
  | { kind: "prepared" }
  | { kind: "duplicate"; status: OpStatus }
  | { kind: "conflict" }
  | { kind: "expired" };

export type StartResponse =
  | { kind: "accepted" }
  | { kind: "duplicate"; status: OpStatus }
  | { kind: "stale_epoch" }
  | { kind: "expired" };

export type CancelResponse =
  | { kind: "stopped" }
  | { kind: "already_done" }
  | { kind: "not_found" }
  | { kind: "unknown" }
  | { kind: "stale_epoch" };

/** After ack the output is dropped. The tombstone stays. */
export type AckResponse = { kind: "acked" } | { kind: "not_found" } | { kind: "stale_epoch" };

export interface OpenOperation {
  opId: OpId;
  intentId: string;
  incarnation: Incarnation;
  status: OpStatus;
}

export interface FenceResponse {
  /** The session's minimum epoch after the fence. */
  minEpoch: OwnerEpoch;
  /** Every operation of the session that is not terminal. */
  open: OpenOperation[];
}

/**
 * The executor, as the session actor sees it.
 *
 * Rules:
 * - `prepare` is idempotent: same op_id and input hash gives `duplicate`.
 * - Takeover adopts, it does not re-create: commit the higher epoch, then
 *   `fence`, then act once on each open operation.
 * - Dispatch is uncertain: the caller never records "sent", and retries with
 *   the same op_id.
 * - `start`, `cancel` and `ack` with an epoch below the session minimum give
 *   `stale_epoch`.
 */
export interface Executor {
  prepare(req: PrepareRequest): Promise<PrepareResponse>;
  start(opId: OpId, ownerEpoch: OwnerEpoch): Promise<StartResponse>;
  status(opId: OpId): Promise<OpStatus>;
  cancel(opId: OpId, ownerEpoch: OwnerEpoch): Promise<CancelResponse>;
  ack(opId: OpId, ownerEpoch: OwnerEpoch): Promise<AckResponse>;
  fence(session: string, ownerEpoch: OwnerEpoch): Promise<FenceResponse>;
  describe(workspace: string): Promise<{ incarnation: Incarnation }>;
}
