import type { Command, CommandResult, LaunchStatus, OpId } from "@hermesd/executor-protocol";
import { reconcileLaunch } from "@hermesd/executor-protocol";
import type { JournalEntry, SimulatedVm } from "./vm.ts";

/** The helper's answer for one op_id. `not_found` means the journal has no entry. */
export type GuestStatus = { status: "not_found" } | { status: LaunchStatus; result?: CommandResult };

export interface LaunchRequest {
  opId: OpId;
  incarnation: number;
  cmd: Command;
}

/**
 * The guest helper, as the executor cell sees it.
 *
 * Every method throws `VmUnavailableError` when the VM is not running.
 */
export interface Guest {
  /** Follow the four launch steps of section 3.4. Answers from the journal if it can. */
  launch(req: LaunchRequest): Promise<GuestStatus>;
  status(opId: OpId): Promise<GuestStatus>;
  /** Stop the command, or take the claim so that it can never start. */
  cancel(opId: OpId): Promise<GuestStatus>;
}

/** The program that a command runs. It is a function in the simulation. */
export type CommandFn = (cmd: Command, ctx: { opId: OpId; signal: AbortSignal }) => CommandResult | Promise<CommandResult>;

interface Unit {
  abort: AbortController;
  done: Promise<void>;
  /** Set when the unit was stopped. A late result is then discarded. */
  killed: boolean;
}

/**
 * A guest helper that runs a command function.
 *
 * The run counter is the oracle for "one run". The guest increments it at
 * the moment the shim wins the claim, just before the command function is
 * called. The counter is not on the simulated disk, so a restore does not
 * roll it back. Tests read the counter. They never read the cell's receipt.
 */
export class SimulatedGuest implements Guest {
  readonly #vm: SimulatedVm;
  readonly #run: CommandFn;
  readonly #counts = new Map<OpId, number>();
  #units = new Map<OpId, Unit>();
  /** Every unit that ever started, also killed ones, until its function returns. */
  readonly #pending = new Set<Promise<void>>();

  constructor(vm: SimulatedVm, run: CommandFn) {
    this.#vm = vm;
    this.#run = run;
    vm.onHalt(() => {
      // A run ended. Every unit dies with it and writes no exit status.
      for (const unit of this.#units.values()) {
        unit.killed = true;
        unit.abort.abort();
      }
      this.#units = new Map();
    });
  }

  /** How often the command of this op_id ran. */
  runCount(opId: OpId): number {
    return this.#counts.get(opId) ?? 0;
  }

  /** The sum over all operations. */
  totalRuns(): number {
    let n = 0;
    for (const c of this.#counts.values()) n += c;
    return n;
  }

  /**
   * Wait until every command function has returned, also the late results
   * of stopped units. A command that waits for a release keeps this open.
   */
  async idle(): Promise<void> {
    await Promise.all([...this.#pending]);
  }

  /**
   * The helper process restarts. Units live in their own cgroup and keep
   * running. The journal is on disk. The model has no helper memory, so
   * there is nothing to lose. The method exists to make the fault explicit.
   */
  restartHelper(): void {
    this.#vm.assertRunning();
  }

  #evidence(opId: OpId, entry: JournalEntry) {
    return {
      olderBoot: entry.bootId !== this.#vm.runId,
      claimFile: entry.claim,
      unitAlive: this.#units.has(opId),
      exitStatusWritten: entry.exit !== undefined,
      ...(entry.exit ? { exitCode: entry.exit.code } : {}),
    };
  }

  #answer(opId: OpId): GuestStatus {
    const entry = this.#vm.disk.journal.get(opId);
    if (!entry) return { status: "not_found" };
    const status = reconcileLaunch(this.#evidence(opId, entry));
    return entry.exit ? { status, result: entry.exit.result } : { status };
  }

  async status(opId: OpId): Promise<GuestStatus> {
    this.#vm.assertRunning();
    return this.#answer(opId);
  }

  async launch(req: LaunchRequest): Promise<GuestStatus> {
    this.#vm.assertRunning();
    const { opId } = req;
    // Step 1: answer from the journal. Only not_launched allows a new launch.
    const known = this.#answer(opId);
    if (known.status !== "not_found" && known.status !== "not_launched") return known;
    // Step 2: write "launching" and sync it.
    this.#vm.writeJournal(opId, (old) => ({
      opId,
      incarnation: req.incarnation,
      bootId: this.#vm.runId!,
      claim: old?.claim ?? false,
    }));
    // Step 3: the shim takes the claim, then runs the command. In the model
    // the claim is an exclusive create on the journal entry.
    this.#startUnit(req);
    // Step 4: "launched" is implied by the live unit. Answer.
    return this.#answer(opId);
  }

  #startUnit(req: LaunchRequest): void {
    const { opId, cmd } = req;
    const entry = this.#vm.disk.journal.get(opId)!;
    if (entry.claim) return; // The shim exits at once and runs nothing.
    this.#vm.writeJournal(opId, (old) => ({ ...old!, claim: true }));
    this.#counts.set(opId, this.runCount(opId) + 1);
    const abort = new AbortController();
    const unit: Unit = { abort, killed: false, done: Promise.resolve() };
    unit.done = Promise.resolve()
      .then(() => this.#run(cmd, { opId, signal: abort.signal }))
      .catch((e: unknown): CommandResult => ({ exitCode: 1, stdout: "", stderr: String(e) }))
      .then((result) => {
        if (unit.killed) return; // A late result is discarded.
        this.#units.delete(opId);
        this.#vm.writeJournal(opId, (old) => ({ ...old!, exit: { code: result.exitCode, result } }));
      });
    this.#units.set(opId, unit);
    this.#pending.add(unit.done);
    void unit.done.finally(() => this.#pending.delete(unit.done));
  }

  async cancel(opId: OpId): Promise<GuestStatus> {
    this.#vm.assertRunning();
    const unit = this.#units.get(opId);
    if (unit) {
      unit.killed = true;
      unit.abort.abort();
      this.#units.delete(opId);
      const result: CommandResult = { exitCode: 137, stdout: "", stderr: "killed" };
      this.#vm.writeJournal(opId, (old) => ({ ...old!, exit: { code: 137, result } }));
      return this.#answer(opId);
    }
    const entry = this.#vm.disk.journal.get(opId);
    if (!entry || (!entry.claim && !entry.exit)) {
      // Take the claim so that no late shim can ever run the command.
      const result: CommandResult = { exitCode: 137, stdout: "", stderr: "cancelled before launch" };
      this.#vm.writeJournal(opId, (old) => ({
        opId,
        incarnation: old?.incarnation ?? 0,
        bootId: this.#vm.runId!,
        claim: true,
        exit: { code: 137, result },
      }));
    }
    return this.#answer(opId);
  }
}
