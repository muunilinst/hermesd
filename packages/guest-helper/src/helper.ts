import * as fs from "node:fs";
import { reconcileLaunch, type LaunchEvidence, type LaunchStatus } from "@hermesd/executor-protocol";
import { mkdirpDurable } from "./fsutil.ts";
import { Journal, isFinal, type JournalEntry } from "./journal.ts";
import { assertOpId, layout, unitName, type Layout } from "./paths.ts";
import { readKernelBootId, type BootIdSource } from "./proc.ts";
import type { UnitManager } from "./unit-manager.ts";

/** Places where tests can stop the helper. They are named after the four launch steps. */
export type FaultPoint =
  /** After step 2: `launching` is durable; no unit is started. */
  | "after_launching_write"
  /** After step 3: the unit is started; `launched` is not written. */
  | "after_unit_start"
  /** After step 4: `launched` is durable; the answer is not sent. */
  | "after_launched_write";

export type HelperStatus = LaunchStatus | "launched" | "not_found";

export interface HelperResponse {
  opId: string;
  /**
   * "launched" is the answer to a fresh launch (step 4). It means a unit was
   * started; it does not say that the claim exists. Every other value is
   * the reconciled state.
   */
  status: HelperStatus;
  unit?: string | undefined;
  exitCode?: number | undefined;
  /** Directory with stdout, stderr and exit.json once the command ran. */
  outputDir?: string | undefined;
  /** The journal sequence after this call. */
  journalSeq: number;
}

export interface GuestHelperOptions {
  /** The workspace disk directory. The journal, claim files and outputs live under it. */
  workspace: string;
  units: UnitManager;
  /** Replace it in tests to simulate a boot. */
  bootId?: BootIdSource;
  /** Called at each fault point. A test may kill the process here. */
  onStep?: (point: FaultPoint) => void | Promise<void>;
}

/**
 * The guest helper's launch and reconcile logic (porting guide rev 5.1, 3.4).
 *
 * `launch` follows four steps in order:
 *  1. If the journal has the op_id, answer from the journal.
 *  2. Write `launching` and sync it.
 *  3. Start the unit. Its first process is the shim, which claims, then runs.
 *  4. Write `launched` and sync it, then answer.
 *
 * The helper never relaunches on a guess. Any doubt gives `unknown`.
 * Calls are serialised, so two requests in one helper cannot interleave.
 */
export class GuestHelper {
  readonly workspace: string;
  readonly #units: UnitManager;
  readonly #bootId: BootIdSource;
  readonly #onStep: (point: FaultPoint) => void | Promise<void>;
  readonly #L: Layout;
  readonly #journal: Journal;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(opts: GuestHelperOptions) {
    this.workspace = opts.workspace;
    this.#units = opts.units;
    this.#bootId = opts.bootId ?? readKernelBootId;
    this.#onStep = opts.onStep ?? (() => {});
    this.#L = layout(opts.workspace);
    mkdirpDurable(this.#L.claimsDir);
    mkdirpDurable(this.#L.opsDir);
    this.#journal = new Journal(this.#L.journal);
  }

  #serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(f, f);
    this.#chain = run.catch(() => {});
    return run;
  }

  /** The boot handshake: reconcile, then report the boot ID and the journal sequence. */
  handshake(): Promise<{ bootId: string; journalSeq: number; reconciled: HelperResponse[] }> {
    return this.#serial(async () => {
      const reconciled = await this.#reconcile();
      return { bootId: this.#bootId(), journalSeq: this.#journal.seq, reconciled };
    });
  }

  /** Apply the reconciliation table to every journal entry that has no final status. */
  reconcile(): Promise<HelperResponse[]> {
    return this.#serial(() => this.#reconcile());
  }

  async #reconcile(): Promise<HelperResponse[]> {
    this.#journal.reload();
    const out: HelperResponse[] = [];
    for (const opId of this.#journal.opIds()) {
      const entry = this.#journal.entry(opId);
      if (!entry || isFinal(entry.outcome?.status)) continue;
      out.push(await this.#resolve(entry));
    }
    return out;
  }

  /** status(op_id): the reconciled state of one operation, or not_found. */
  status(opId: string): Promise<HelperResponse> {
    assertOpId(opId);
    return this.#serial(async () => {
      this.#journal.reload();
      const entry = this.#journal.entry(opId);
      if (!entry) return this.#response(opId, "not_found");
      return this.#resolve(entry);
    });
  }

  /** Stop the units of an operation. The shim cannot write an exit status then, so the result is unknown. */
  cancel(opId: string): Promise<void> {
    assertOpId(opId);
    return this.#serial(() => this.#units.stop(opId));
  }

  launch(opId: string, incarnation: number, cmd: string): Promise<HelperResponse> {
    assertOpId(opId);
    return this.#serial(() => this.#launch(opId, incarnation, cmd));
  }

  async #launch(opId: string, incarnation: number, cmd: string): Promise<HelperResponse> {
    this.#journal.reload();
    // Step 1: the journal has the op_id: answer from the journal.
    const known = this.#journal.entry(opId);
    let attempt = 1;
    if (known) {
      const r = await this.#resolve(known);
      // Only not_launched permits a new launch. Everything else, including unknown, is the answer.
      if (r.status !== "not_launched") return r;
      attempt = known.attempt + 1;
    }
    const bootId = this.#bootId();
    const unit = unitName(opId, attempt);
    // Step 2: write `launching` and sync it.
    this.#journal.append({ type: "launching", opId, incarnation, attempt, unit, cmd, bootId });
    await this.#onStep("after_launching_write");
    // Step 3: start the unit. The shim claims, then runs the command.
    const info = await this.#units.start({ unit, opId, workspace: this.workspace, cmd });
    await this.#onStep("after_unit_start");
    // Step 4: write `launched` and sync it, then answer.
    this.#journal.append({
      type: "launched",
      opId,
      attempt,
      unit,
      pid: info.pid ?? -1,
      startTime: info.startTime ?? "",
      bootId,
    });
    await this.#onStep("after_launched_write");
    return this.#response(opId, "launched", { unit });
  }

  /** Gather the evidence for one entry. Returns undefined when the claim or exit files cannot be read. */
  async #evidence(entry: JournalEntry): Promise<LaunchEvidence | undefined> {
    const opId = entry.opId;
    let claimFile: boolean;
    let exitStatusWritten = false;
    let exitCode: number | undefined;
    try {
      claimFile = fs.existsSync(this.#L.claim(opId));
      // existsSync hides errors; stat the directory to tell "absent" from "cannot read".
      fs.accessSync(this.#L.claimsDir, fs.constants.R_OK | fs.constants.X_OK);
      try {
        const x = JSON.parse(fs.readFileSync(this.#L.exit(opId), "utf8")) as { code: number | null };
        exitStatusWritten = true;
        exitCode = x.code ?? 128;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
    } catch {
      return undefined;
    }
    const q = await this.#units.query(opId, entry.launched ? { pid: entry.launched.pid, startTime: entry.launched.startTime } : undefined);
    const ev: LaunchEvidence = {
      olderBoot: entry.bootId !== this.#bootId(),
      claimFile,
      unitAlive: q.alive,
      exitStatusWritten,
    };
    if (exitCode !== undefined) ev.exitCode = exitCode;
    return ev;
  }

  /** Reconcile one entry, record what is worth recording, and describe it. */
  async #resolve(entry: JournalEntry): Promise<HelperResponse> {
    const opId = entry.opId;
    const prev = entry.outcome?.status;
    if (isFinal(prev)) return this.#response(opId, prev as LaunchStatus, { unit: entry.unit, exitCode: entry.outcome?.exitCode });

    const ev = await this.#evidence(entry);
    // Files that cannot be read: the launch cannot be established. Do not record it; the cause can pass.
    if (!ev) return this.#response(opId, "unknown", { unit: entry.unit });
    let status = reconcileLaunch(ev);

    // `unknown` is sticky. It may only turn into done or failed, when an exit status shows up.
    if (prev === "unknown" && !ev.exitStatusWritten) status = "unknown";

    const bootId = this.#bootId();
    const same = prev === status;
    if (status === "done" || status === "failed") {
      this.#journal.append({ type: "outcome", opId, status, exitCode: ev.exitCode ?? -1, bootId });
    } else if (status === "unknown") {
      // Record a deterministic unknown. An unreadable unit is not recorded: it may be readable later.
      if (!same && ev.unitAlive !== undefined) this.#journal.append({ type: "outcome", opId, status, bootId });
    } else if (status === "not_launched") {
      if (!same) this.#journal.append({ type: "outcome", opId, status, bootId });
    } else if (status === "starting" || status === "running") {
      // Adopt: remember the unit that is alive, if the journal has no `launched` for it.
      if (!entry.launched) {
        const q = await this.#units.query(opId);
        const u = q.units[0];
        if (u?.pid !== undefined && u.startTime !== undefined) {
          this.#journal.append({
            type: "launched",
            opId,
            attempt: entry.attempt,
            unit: u.unit,
            pid: u.pid,
            startTime: u.startTime,
            bootId,
          });
        }
      }
    }
    return this.#response(opId, status, { unit: entry.unit, exitCode: ev.exitCode });
  }

  #response(opId: string, status: HelperStatus, extra: { unit?: string | undefined; exitCode?: number | undefined } = {}): HelperResponse {
    const r: HelperResponse = { opId, status, journalSeq: this.#journal.seq };
    if (extra.unit !== undefined) r.unit = extra.unit;
    if (extra.exitCode !== undefined) r.exitCode = extra.exitCode;
    if (status === "done" || status === "failed") r.outputDir = this.#L.opDir(opId);
    return r;
  }
}
