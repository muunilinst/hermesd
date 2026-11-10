import type { CommandResult, OpId } from "@hermesd/executor-protocol";
import { ProtocolError, VmUnavailableError } from "./errors.ts";

/** A save of the VM disks. */
export interface VmSave {
  id: string;
  lineage: string;
  /** True when the disks may differ from the stored save. */
  candidate: boolean;
}

export type VmStatus = "running" | "stopped" | "recovery_required";

/** What the VM reports at the boot handshake of a run. */
export interface VmHandshake {
  runId: string;
  /** Advances with every accepted operation. */
  revision: number;
  save: VmSave;
  status: VmStatus;
  /** The guest helper's journal sequence. It counts journal writes. */
  journalSeq: number;
}

/** What the VM reports when it stops a run. */
export interface VmStopReceipt {
  runId: string;
  revision: number;
  save: VmSave;
  journalSeq: number;
}

/** What can be read when the VM is not running. */
export interface VmPeek {
  status: VmStatus;
  revision: number;
  save: VmSave;
  journalSeq: number;
  runId: string | undefined;
}

/** One entry of the launch journal on the workspace disk. */
export interface JournalEntry {
  opId: OpId;
  incarnation: number;
  /** The boot (run) in which the entry was written. */
  bootId: string;
  claim: boolean;
  exit?: { code: number; result: CommandResult };
}

/** The workspace disk. The launch journal lives here. */
export interface Disk {
  journal: Map<OpId, JournalEntry>;
  journalSeq: number;
}

interface StoredSave {
  save: VmSave;
  disk: Disk;
}

/**
 * A simulated TeenyTiny VM.
 *
 * It has a run_id, a revision, a current save (with candidate and lineage),
 * a status and the lifecycle operations. Every accepted operation advances
 * the revision. The workspace disk holds the guest journal. A save keeps a
 * copy of the disk.
 */
export class SimulatedVm {
  #runCounter = 0;
  #saveCounter = 0;
  #lineageCounter = 0;
  #saves = new Map<string, StoredSave>();
  #haltHooks: Array<() => void> = [];
  #runId: string | undefined;
  #status: VmStatus = "stopped";
  #revision = 0;
  #save: VmSave;
  disk: Disk = { journal: new Map(), journalSeq: 0 };

  constructor() {
    this.#save = this.#makeSave(this.#newLineage());
  }

  #newLineage(): string {
    return `lineage-${++this.#lineageCounter}`;
  }

  #makeSave(lineage: string): VmSave {
    const save: VmSave = { id: `save-${++this.#saveCounter}`, lineage, candidate: false };
    this.#saves.set(save.id, { save, disk: structuredClone(this.disk) });
    return save;
  }

  /** The guest registers a hook. It runs when a run ends for any reason. */
  onHalt(hook: () => void): void {
    this.#haltHooks.push(hook);
  }

  #halt(): void {
    for (const hook of this.#haltHooks) hook();
  }

  get runId(): string | undefined {
    return this.#runId;
  }

  get status(): VmStatus {
    return this.#status;
  }

  get saveIds(): string[] {
    return [...this.#saves.keys()];
  }

  peek(): VmPeek {
    return {
      status: this.#status,
      revision: this.#revision,
      save: { ...this.#save },
      journalSeq: this.disk.journalSeq,
      runId: this.#runId,
    };
  }

  /** The boot handshake. Only a running VM answers. */
  handshake(): VmHandshake {
    this.assertRunning();
    return {
      runId: this.#runId!,
      revision: this.#revision,
      save: { ...this.#save },
      status: this.#status,
      journalSeq: this.disk.journalSeq,
    };
  }

  assertRunning(): void {
    if (this.#status !== "running") throw new VmUnavailableError(`VM is ${this.#status}`);
  }

  /** The guest helper writes the journal through this method. */
  writeJournal(opId: OpId, change: (entry: JournalEntry | undefined) => JournalEntry): void {
    this.disk.journal.set(opId, change(this.disk.journal.get(opId)));
    this.disk.journalSeq += 1;
  }

  #need(status: VmStatus, op: string): void {
    if (this.#status !== status) throw new ProtocolError(`${op} needs a ${status} VM, it is ${this.#status}`);
  }

  /** Start a new run. The run gets a new run_id. */
  start(): VmHandshake {
    this.#need("stopped", "start");
    this.#revision += 1;
    this.#runId = `run-${++this.#runCounter}`;
    this.#status = "running";
    return this.handshake();
  }

  /** Stop the run. The stop produces a new save in the same lineage. */
  stop(): VmStopReceipt {
    this.#need("running", "stop");
    this.#halt();
    this.#revision += 1;
    this.#status = "stopped";
    this.#save = this.#makeSave(this.#save.lineage);
    return { runId: this.#runId!, revision: this.#revision, save: { ...this.#save }, journalSeq: this.disk.journalSeq };
  }

  /** Put the disks back to an older (or the same) save. */
  restoreDisks(saveId: string): void {
    this.#need("stopped", "restore_disks");
    const stored = this.#saves.get(saveId);
    if (!stored) throw new ProtocolError(`unknown save ${saveId}`);
    this.#revision += 1;
    this.disk = structuredClone(stored.disk);
    this.#save = { ...stored.save };
  }

  /** New image, new lineage. The data disks and their journal stay. */
  replaceImage(): void {
    this.#need("stopped", "replace_image");
    this.#revision += 1;
    this.#save = this.#makeSave(this.#newLineage());
  }

  /** Drop the changes since the current save. The run ends. */
  discard(): void {
    if (this.#status === "recovery_required") throw new ProtocolError("discard needs a VM that is not in recovery");
    this.#halt();
    this.#revision += 1;
    this.#status = "stopped";
    this.disk = structuredClone(this.#saves.get(this.#save.id)!.disk);
  }

  /** The VM needs recovery. The run ends. */
  markRecoveryRequired(): void {
    this.#halt();
    this.#revision += 1;
    this.#status = "recovery_required";
  }

  /** Recover. The disks may differ from the stored save, so the save is a candidate. */
  recover(): void {
    this.#need("recovery_required", "recover");
    this.#revision += 1;
    this.#status = "stopped";
    this.#save = { ...this.#save, candidate: true };
  }

  /**
   * The host is lost. Unsaved disk changes are gone. Nobody saw the run
   * stop, and no save was made.
   */
  loseHost(): void {
    this.#halt();
    this.#revision += 1;
    this.#status = "stopped";
    this.disk = structuredClone(this.#saves.get(this.#save.id)!.disk);
  }

  /**
   * Test hook. Force the journal sequence to a value. This models a
   * rollback that the lifecycle rule alone cannot see.
   */
  forceJournalSeq(value: number): void {
    this.disk.journalSeq = value;
  }
}
