import type {
  AckResponse,
  CancelResponse,
  Command,
  Executor,
  FenceResponse,
  Incarnation,
  OpId,
  OpStatus,
  OwnerEpoch,
  PrepareRequest,
  PrepareResponse,
  StartResponse,
} from "@hermesd/executor-protocol";
import { isTerminal } from "@hermesd/executor-protocol";
import { CellCrashedError, CellDownError, ProtocolError, VmUnavailableError } from "./errors.ts";
import type { Guest, GuestStatus } from "./guest.ts";
import type { SimulatedVm, VmSave } from "./vm.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One entry of the operation log. It is durable. */
export interface OpRecord {
  opId: OpId;
  session: string;
  intentId: string;
  incarnation: Incarnation;
  inputHash: string;
  cmd: Command;
  /** The epoch of the owner that prepared, started or adopted the operation. */
  ownerEpoch: OwnerEpoch;
  status: OpStatus;
  /** The output was dropped (after ack, or at the retention ceiling). */
  outputDropped: boolean;
  acked: boolean;
  /** When the operation became terminal. Used by retention. */
  finishedAt?: number;
}

/** What the cell must remember to prove that a new run continues the last one. */
export interface ContinuityBase {
  save: VmSave;
  /** The VM revision right after the operation that made the base. */
  revision: number;
}

/** The durable state of the cell. A crash does not touch it. */
export interface CellDurable {
  incarnation: Incarnation;
  ops: Map<OpId, OpRecord>;
  minEpoch: Map<string, OwnerEpoch>;
  /** The run_id that the cell has checked. */
  checkedRunId: string | undefined;
  base: ContinuityBase | undefined;
  /** The highest journal sequence that the cell has seen. */
  highestJournalSeq: number;
  /** The revision at which the cell last saw `recovery_required`. */
  recoveryNotedRevision: number | undefined;
  /** Records of incarnations below this value may have been collected. */
  collectedBelow: Incarnation;
  /** Why each incarnation started. For tests and operators. */
  advances: Array<{ incarnation: Incarnation; reason: string }>;
}

export function newDurable(): CellDurable {
  return {
    incarnation: 0,
    ops: new Map(),
    minEpoch: new Map(),
    checkedRunId: undefined,
    base: undefined,
    highestJournalSeq: 0,
    recoveryNotedRevision: undefined,
    collectedBelow: 0,
    advances: [],
  };
}

/** The points where a test can crash the cell. */
export type CrashPoint =
  | "start:dispatching-written"
  | "start:guest-launched"
  | "start:running-recorded"
  | "lifecycle:vm-done"
  | "lifecycle:before-start-record";

export interface RetentionPolicy {
  /** Output is never dropped before this age without ack. */
  floorMs: number;
  /** The operator's ceiling. Without one, unacknowledged output stays. */
  ceilingMs?: number;
}

export interface CellOptions {
  vm: SimulatedVm;
  guest: Guest;
  workspace: string;
  durable?: CellDurable;
  now?: () => number;
  retention?: Partial<RetentionPolicy>;
}

/**
 * The executor cell: an in-memory reference model of section 3.4.
 *
 * Durable state is in `CellDurable`. It is written before the cell answers.
 * Process state is only `#alive` and the armed crash point. `crash()` and
 * `restart()` lose the process state and keep the durable state.
 *
 * The cell has no memory of in-flight commands. It reads the guest each time
 * it needs the state of a command, so a restart cannot lose a result.
 */
export class ExecutorCell implements Executor {
  readonly workspace: string;
  readonly #vm: SimulatedVm;
  readonly #guest: Guest;
  readonly #now: () => number;
  readonly retention: RetentionPolicy;
  #d: CellDurable;
  #alive = true;
  #armed: CrashPoint | undefined;

  constructor(opts: CellOptions) {
    this.workspace = opts.workspace;
    this.#vm = opts.vm;
    this.#guest = opts.guest;
    this.#now = opts.now ?? Date.now;
    this.#d = opts.durable ?? newDurable();
    const floorMs = Math.max(opts.retention?.floorMs ?? 7 * DAY_MS, 7 * DAY_MS);
    const ceilingMs = opts.retention?.ceilingMs;
    this.retention = { floorMs, ...(ceilingMs === undefined ? {} : { ceilingMs: Math.max(ceilingMs, floorMs) }) };
  }

  // ---------------------------------------------------------------- process

  get alive(): boolean {
    return this.#alive;
  }

  /** The process dies. Durable state stays. */
  crash(): void {
    this.#alive = false;
    this.#armed = undefined;
  }

  /** Arm a crash. The cell dies the next time it reaches this point. */
  crashAt(point: CrashPoint): void {
    this.#armed = point;
  }

  #hit(point: CrashPoint): void {
    if (this.#armed === point) {
      this.crash();
      throw new CellCrashedError(`crashed at ${point}`);
    }
  }

  /**
   * The process starts again with its durable state, then resolves every
   * operation that was in flight. This is the "owner node died" path too.
   */
  async restart(): Promise<void> {
    this.#alive = true;
    this.#armed = undefined;
    await this.#recover();
  }

  /** A copy of the durable state, as a new owner node restores it. */
  exportDurable(): CellDurable {
    return structuredClone(this.#d);
  }

  /** The durable state, read only. For tests. */
  inspect(): Readonly<CellDurable> {
    return this.#d;
  }

  async #recover(): Promise<void> {
    try {
      this.#checkRun();
      for (const rec of this.#d.ops.values()) {
        if (rec.incarnation === this.#d.incarnation && rec.status.status === "dispatching") await this.#settle(rec);
      }
    } catch (e) {
      if (!(e instanceof VmUnavailableError)) throw e;
      // The VM is down. The next call resolves the operations.
    }
  }

  #guard(): void {
    if (!this.#alive) throw new CellDownError("the cell is down");
    this.#checkRun();
  }

  // ------------------------------------------------------ incarnation rules

  #advance(reason: string): void {
    this.#d.incarnation += 1;
    this.#d.advances.push({ incarnation: this.#d.incarnation, reason });
    for (const rec of this.#d.ops.values()) {
      if (rec.incarnation >= this.#d.incarnation || isTerminal(rec.status.status)) continue;
      // Never started: it did not run. Started: its end is not known.
      this.#finish(rec, rec.status.status === "prepared" ? { status: "expired" } : { status: "unknown" });
    }
  }

  /**
   * The check of a run. It happens before every call, and at every boot
   * handshake of a new run_id. When in doubt it advances.
   */
  #checkRun(): void {
    const d = this.#d;
    const peek = this.#vm.peek();
    if (peek.status === "recovery_required") {
      if (d.recoveryNotedRevision !== peek.revision) {
        d.recoveryNotedRevision = peek.revision;
        d.base = undefined;
        this.#advance("recovery_required");
      }
      return;
    }
    if (peek.status !== "running") return;
    const hs = this.#vm.handshake();
    if (hs.runId === d.checkedRunId) {
      d.highestJournalSeq = Math.max(d.highestJournalSeq, hs.journalSeq);
      return;
    }
    // A new run_id. Prove continuity, or start a new incarnation.
    const reason = this.#continuityFailure(hs.save, hs.revision, hs.journalSeq);
    if (reason !== undefined) this.#advance(reason);
    d.checkedRunId = hs.runId;
    d.base = undefined;
    // After a rollback the old highest value does not apply any more.
    d.highestJournalSeq = reason === undefined ? Math.max(d.highestJournalSeq, hs.journalSeq) : hs.journalSeq;
  }

  #continuityFailure(save: VmSave, revision: number, journalSeq: number): string | undefined {
    const d = this.#d;
    const base = d.base;
    if (base === undefined) return "no recorded stop of a run this cell served";
    if (save.candidate || base.save.candidate) return "the save is a candidate";
    if (save.id !== base.save.id) return "the save is not the one recorded at the last stop";
    if (save.lineage !== base.save.lineage) return "the lineage changed";
    if (revision !== base.revision + 1) return "another operation lies between the stop and this run";
    if (journalSeq < d.highestJournalSeq) return "the journal sequence is lower than the highest seen";
    return undefined;
  }

  // ------------------------------------------------------------- lifecycle

  /** Start a run through the cell. The cell checks the new run at once. */
  async startVm(): Promise<void> {
    this.#guard();
    this.#vm.start();
    this.#hit("lifecycle:before-start-record");
    this.#checkRun();
  }

  /** Stop the run through the cell. The cell records the save of the stop. */
  async stopVm(): Promise<void> {
    this.#guard();
    // Read the result of every open command while the guest can still answer.
    for (const rec of this.#d.ops.values()) await this.#trySettle(rec, false);
    const receipt = this.#vm.stop();
    this.#hit("lifecycle:vm-done");
    this.#d.base = { save: receipt.save, revision: receipt.revision };
    this.#d.highestJournalSeq = Math.max(this.#d.highestJournalSeq, receipt.journalSeq);
  }

  /** A lifecycle operation that changes the disks. The incarnation advances in the same step. */
  async #disruptive(reason: string, op: () => void): Promise<void> {
    this.#guard();
    op();
    this.#hit("lifecycle:vm-done");
    const peek = this.#vm.peek();
    this.#advance(reason);
    this.#d.checkedRunId = undefined;
    this.#d.base = peek.save.candidate ? undefined : { save: peek.save, revision: peek.revision };
    this.#d.highestJournalSeq = peek.journalSeq;
  }

  async restoreDisks(saveId: string): Promise<void> {
    await this.#disruptive("restore_disks", () => this.#vm.restoreDisks(saveId));
  }

  async replaceImage(): Promise<void> {
    await this.#disruptive("replace_image", () => this.#vm.replaceImage());
  }

  async discard(): Promise<void> {
    await this.#disruptive("discard", () => this.#vm.discard());
  }

  async recover(): Promise<void> {
    await this.#disruptive("recover", () => this.#vm.recover());
  }

  // -------------------------------------------------------------- contract

  async describe(workspace: string): Promise<{ incarnation: Incarnation }> {
    this.#guard();
    if (workspace !== this.workspace) throw new ProtocolError(`unknown workspace ${workspace}`);
    if (this.#d.incarnation === 0) throw new VmUnavailableError("the cell has not checked a run yet");
    return { incarnation: this.#d.incarnation };
  }

  async prepare(req: PrepareRequest): Promise<PrepareResponse> {
    this.#guard();
    const d = this.#d;
    // Refused by number. Nothing else is read.
    if (req.incarnation < d.incarnation) return { kind: "expired" };
    if (req.incarnation > d.incarnation) throw new ProtocolError("incarnation is higher than the current one");
    const old = d.ops.get(req.opId);
    if (old) {
      if (old.inputHash !== req.inputHash) return { kind: "conflict" };
      await this.#trySettle(old);
      return { kind: "duplicate", status: this.#view(old) };
    }
    d.ops.set(req.opId, {
      opId: req.opId,
      session: req.session,
      intentId: req.intentId,
      incarnation: req.incarnation,
      inputHash: req.inputHash,
      cmd: req.cmd,
      ownerEpoch: 0,
      status: { status: "prepared" },
      outputDropped: false,
      acked: false,
    });
    return { kind: "prepared" };
  }

  async start(opId: OpId, epoch: OwnerEpoch): Promise<StartResponse> {
    this.#guard();
    const d = this.#d;
    const rec = d.ops.get(opId);
    if (!rec) {
      if (d.collectedBelow > 0) return { kind: "expired" };
      throw new ProtocolError(`start of an unknown operation ${opId}`);
    }
    if (epoch < this.#minEpoch(rec.session)) return { kind: "stale_epoch" };
    if (rec.incarnation < d.incarnation) return { kind: "expired" };
    if (rec.status.status !== "prepared") {
      await this.#trySettle(rec);
      return { kind: "duplicate", status: this.#view(rec) };
    }
    this.#vm.assertRunning();
    rec.ownerEpoch = epoch;
    rec.status = { status: "dispatching" };
    this.#hit("start:dispatching-written");
    const answer = await this.#guest.launch({ opId, incarnation: rec.incarnation, cmd: rec.cmd });
    this.#hit("start:guest-launched");
    this.#apply(rec, answer);
    this.#hit("start:running-recorded");
    return { kind: "accepted" };
  }

  async status(opId: OpId): Promise<OpStatus> {
    this.#guard();
    const rec = this.#d.ops.get(opId);
    // The cell has no record. That does not show that nothing ran.
    if (!rec) return { status: "unknown" };
    await this.#settle(rec, { relaunch: true });
    return this.#view(rec);
  }

  async cancel(opId: OpId, epoch: OwnerEpoch): Promise<CancelResponse> {
    this.#guard();
    const rec = this.#d.ops.get(opId);
    if (!rec) return { kind: "not_found" };
    if (epoch < this.#minEpoch(rec.session)) return { kind: "stale_epoch" };
    if (rec.status.status === "prepared") {
      // It was never sent to the guest, so nothing can run.
      this.#finish(rec, { status: "cancelled" });
      return { kind: "stopped" };
    }
    await this.#settle(rec, { relaunch: false });
    const s = rec.status.status;
    if (s === "unknown") return { kind: "unknown" };
    if (isTerminal(s)) return { kind: "already_done" };
    this.#vm.assertRunning();
    const answer = await this.#guest.cancel(opId);
    // The command may have ended just before the cancel.
    if (answer.status === "done" || answer.status === "unknown") {
      this.#apply(rec, answer);
      return answer.status === "done" ? { kind: "already_done" } : { kind: "unknown" };
    }
    this.#finish(rec, { status: "cancelled" });
    return { kind: "stopped" };
  }

  async ack(opId: OpId, epoch: OwnerEpoch): Promise<AckResponse> {
    this.#guard();
    const rec = this.#d.ops.get(opId);
    if (!rec) return { kind: "not_found" };
    if (epoch < this.#minEpoch(rec.session)) return { kind: "stale_epoch" };
    await this.#trySettle(rec);
    if (!isTerminal(rec.status.status)) throw new ProtocolError("ack of an operation that is not terminal");
    rec.acked = true;
    rec.outputDropped = true;
    return { kind: "acked" };
  }

  async fence(session: string, epoch: OwnerEpoch): Promise<FenceResponse> {
    this.#guard();
    const d = this.#d;
    const current = this.#minEpoch(session);
    if (epoch > current) d.minEpoch.set(session, epoch);
    const open: FenceResponse["open"] = [];
    for (const rec of d.ops.values()) {
      if (rec.session !== session || rec.acked) continue;
      if (epoch >= current) {
        await this.#settle(rec, { relaunch: true });
        rec.ownerEpoch = Math.max(rec.ownerEpoch, epoch);
      }
      open.push({ opId: rec.opId, intentId: rec.intentId, incarnation: rec.incarnation, status: this.#view(rec) });
    }
    return { minEpoch: this.#minEpoch(session), open };
  }

  // ------------------------------------------------------------- retention

  /**
   * Drop output that passed the operator's ceiling. Without a ceiling, no
   * output is dropped without ack, however old it is. The floor is 7 days.
   */
  collectExpiredOutput(): OpId[] {
    const dropped: OpId[] = [];
    const ceiling = this.retention.ceilingMs;
    if (ceiling === undefined) return dropped;
    for (const rec of this.#d.ops.values()) {
      if (rec.acked || rec.outputDropped || rec.finishedAt === undefined) continue;
      if (this.#now() - rec.finishedAt >= Math.max(ceiling, this.retention.floorMs)) {
        rec.outputDropped = true;
        dropped.push(rec.opId);
      }
    }
    return dropped;
  }

  /** Remove the tombstones of older incarnations. They are refused by number anyway. */
  collectOldTombstones(): OpId[] {
    const removed: OpId[] = [];
    for (const rec of this.#d.ops.values()) {
      if (rec.incarnation < this.#d.incarnation && rec.acked) {
        this.#d.ops.delete(rec.opId);
        removed.push(rec.opId);
      }
    }
    this.#d.collectedBelow = this.#d.incarnation;
    return removed;
  }

  // --------------------------------------------------------------- helpers

  #minEpoch(session: string): OwnerEpoch {
    return this.#d.minEpoch.get(session) ?? 0;
  }

  /** The status that a caller sees. After the output is dropped, only the terminal status is left. */
  #view(rec: OpRecord): OpStatus {
    const s = rec.status;
    if (!rec.outputDropped) return s;
    if (s.status === "done") return { status: "done", result: { exitCode: 0, stdout: "", stderr: "" } };
    if (s.status === "failed") return { status: "failed", reason: "output dropped" };
    return s;
  }

  #finish(rec: OpRecord, status: OpStatus): void {
    rec.status = status;
    rec.finishedAt = this.#now();
  }

  /** Take the guest's answer into the log. A terminal record never changes. */
  #apply(rec: OpRecord, answer: GuestStatus): void {
    if (isTerminal(rec.status.status)) return;
    switch (answer.status) {
      case "done":
        this.#finish(rec, { status: "done", result: answer.result ?? { exitCode: 0, stdout: "", stderr: "" } });
        return;
      case "failed":
        this.#finish(rec, answer.result ? { status: "failed", result: answer.result } : { status: "failed" });
        return;
      case "unknown":
        this.#finish(rec, { status: "unknown" });
        return;
      case "running":
        rec.status = { status: "running" };
        return;
      case "starting":
      case "not_launched":
      case "not_found":
        // Not running yet. The record stays as it is.
        return;
    }
  }

  async #trySettle(rec: OpRecord, relaunch = true): Promise<void> {
    try {
      await this.#settle(rec, { relaunch });
    } catch (e) {
      // A duplicate answer does not need the guest. Report the stored status.
      if (!(e instanceof VmUnavailableError)) throw e;
    }
  }

  /**
   * Read the guest for a non-terminal operation of the current incarnation.
   *
   * It launches again only when the operation is `dispatching` and the guest
   * proves that the command has not run: no journal entry, or
   * `not_launched`. Any other answer, including `unknown`, never launches.
   */
  async #settle(rec: OpRecord, opts: { relaunch: boolean } = { relaunch: true }): Promise<void> {
    const s = rec.status.status;
    if (rec.incarnation !== this.#d.incarnation) return;
    if (s !== "dispatching" && s !== "running") return;
    this.#vm.assertRunning();
    const answer = await this.#guest.status(rec.opId);
    if (s === "dispatching" && (answer.status === "not_found" || answer.status === "not_launched")) {
      if (!opts.relaunch) return;
      this.#apply(rec, await this.#guest.launch({ opId: rec.opId, incarnation: rec.incarnation, cmd: rec.cmd }));
      return;
    }
    if (s === "running" && (answer.status === "not_found" || answer.status === "not_launched")) {
      // The cell recorded a run that the guest does not know. Do not guess.
      this.#finish(rec, { status: "unknown" });
      return;
    }
    this.#apply(rec, answer);
  }
}
