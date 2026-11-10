import type { Command, Executor, OpId } from "@hermesd/executor-protocol";
import type { Backend } from "./catalogue.ts";

/** The methods of the executor contract. */
export type ExecutorMethod = "prepare" | "start" | "status" | "cancel" | "ack" | "fence" | "describe";

/** A message that can be sent again, as a network can duplicate it. */
export interface Redeliverable {
  deliver(): Promise<unknown>;
}

/**
 * The executor, over a link that can inject faults. Each fault applies once,
 * to the next call of the named method.
 */
export interface FaultableExecutor extends Executor {
  /** The call has its effect. The reply is lost. The caller gets an error. */
  dropReplyNext(method: ExecutorMethod): void;
  /** The call has its effect. Then the caller process dies. The caller gets an error. */
  crashCallerAfterSendNext(method: ExecutorMethod): void;
  /** The message does not arrive now. The caller gets a timeout error. `deliverLast` sends it later. */
  delayNext(method: ExecutorMethod): { deliverLast(): Redeliverable };
  /** A duplicate of the last message of this method. */
  copyOfLast(method: ExecutorMethod): Redeliverable;
}

/** Who sends a VM lifecycle operation. */
export type Via =
  /** Through the executor cell. The cell advances the incarnation in the same step. */
  | "executor"
  /** An operator or console sends it to the VM. The executor does not see it. */
  | "direct";

export interface VmInfo {
  runId: string | undefined;
  revision: number;
  saveId: string;
  lineage: string;
  status: "running" | "stopped" | "recovery_required";
  journalSeq: number;
}

/** The simulated (or real) VM and its lifecycle. */
export interface VmControls {
  info(): Promise<VmInfo>;
  start(via: Via): Promise<void>;
  stop(via: Via): Promise<void>;
  restoreDisks(saveId: string, via: Via): Promise<void>;
  /** Keeps the data disk and its journal. Changes the lineage. */
  replaceImage(via: Via): Promise<void>;
  discard(via: Via): Promise<void>;
  markRecoveryRequired(): Promise<void>;
  recover(via: Via): Promise<void>;
}

/** Faults of the executor cell process. Durable state survives. */
export interface CellControls {
  /** The process dies. Calls fail until `restart`. */
  crash(): Promise<void>;
  /** The same node restarts and resolves open operations. */
  restart(): Promise<void>;
  /** A new owner node restores the log and resolves open operations. */
  failover(): Promise<void>;
}

/** What a scripted command does on the VM. */
export interface CommandSpec {
  /** Wait on this key until `release(key)`. */
  hold?: string;
  exitCode?: number;
  stdout?: string;
}

/** One running system under test. A test makes one world and uses it alone. */
export interface FaultWorld {
  readonly backend: Backend;
  readonly workspace: string;
  /** A session actor's view of the executor. Each call makes a new link, like a new process. */
  executor(session: string): FaultableExecutor;
  opId(session: string, intentId: string): Promise<OpId>;
  /** A command whose behavior the test controls. */
  command(spec?: CommandSpec): Command;
  /** Let a held command end. Returns when its effect is visible to the executor. */
  release(key: string): Promise<void>;
  /**
   * How often the command of this op_id ran. The command itself increments
   * this counter on the VM. Tests never infer a run from the cell's receipt.
   */
  runCount(opId: OpId): Promise<number>;
  /** Wait a short time. Tests poll with it. */
  pause(ms: number): Promise<void>;
  readonly vm: VmControls;
  readonly cell: CellControls;
  close(): Promise<void>;
}

/** A way to run the fault tests. The model, Node, Durable Objects, TeenyTiny and Rivet each bind one. */
export interface FaultBackend {
  readonly name: Backend;
  create(): Promise<FaultWorld>;
}
