import type { Command, OpId } from "@hermesd/executor-protocol";
import { ExecutorCell } from "./cell.ts";
import type { CellDurable, CellOptions } from "./cell.ts";
import { SimulatedGuest } from "./guest.ts";
import type { CommandFn } from "./guest.ts";
import { FaultLink } from "./link.ts";
import { SimulatedVm } from "./vm.ts";

/** What a scripted command does. */
export interface CommandSpec {
  /** The command waits until `release(hold)` is called. */
  hold?: string;
  exitCode?: number;
  stdout?: string;
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

/**
 * Commands that tests can hold and release. A spec is encoded in `argv`, as
 * a real command would be, and the command function reads it back.
 */
export class ScriptedCommands {
  readonly #gates = new Map<string, Gate>();

  #gate(key: string): Gate {
    let g = this.#gates.get(key);
    if (!g) {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      g = { promise, open };
      this.#gates.set(key, g);
    }
    return g;
  }

  command(spec: CommandSpec = {}): Command {
    return { argv: ["scripted", JSON.stringify(spec)] };
  }

  release(key: string): void {
    this.#gate(key).open();
  }

  readonly fn: CommandFn = async (cmd, ctx) => {
    const spec = JSON.parse(cmd.argv[1] ?? "{}") as CommandSpec;
    if (spec.hold !== undefined) {
      const gate = this.#gate(spec.hold);
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true })),
      ]);
      // A stopped unit still returns here. The guest discards the late result.
    }
    return { exitCode: spec.exitCode ?? 0, stdout: spec.stdout ?? "", stderr: "" };
  };
}

/**
 * A complete simulated host: VM, guest helper, scripted commands and one
 * executor cell. `failover()` models a new owner node that restores the
 * cell's durable log.
 */
export class ModelRig {
  readonly workspace = "ws-1";
  readonly vm = new SimulatedVm();
  readonly commands = new ScriptedCommands();
  readonly guest = new SimulatedGuest(this.vm, this.commands.fn);
  #cell: ExecutorCell;
  #clock = 1_000_000;
  readonly #cellOptions: Pick<CellOptions, "retention">;

  constructor(opts: Pick<CellOptions, "retention"> = {}) {
    this.#cellOptions = opts;
    this.#cell = this.#makeCell();
  }

  #makeCell(durable?: CellDurable): ExecutorCell {
    return new ExecutorCell({
      vm: this.vm,
      guest: this.guest,
      workspace: this.workspace,
      now: () => this.#clock,
      ...(durable ? { durable } : {}),
      ...this.#cellOptions,
    });
  }

  get cell(): ExecutorCell {
    return this.#cell;
  }

  /** Move the clock of the cell. */
  advanceClock(ms: number): void {
    this.#clock += ms;
  }

  /** The old node dies. A new node restores the log and resolves open operations. */
  async failover(): Promise<ExecutorCell> {
    const durable = this.#cell.exportDurable();
    this.#cell.crash();
    this.#cell = this.#makeCell(durable);
    await this.#cell.restart();
    return this.#cell;
  }

  /** A link for one session, with fault injection. It follows the current cell. */
  link(session: string): FaultLink {
    return new FaultLink(() => this.#cell.forSession(session));
  }

  runCount(opId: OpId): number {
    return this.guest.runCount(opId);
  }

  /** Let units finish their work. */
  async settle(): Promise<void> {
    await this.guest.idle();
  }
}
