import * as fs from "node:fs";
import { join } from "node:path";
import { layout, testkit } from "@hermesd/guest-helper";

/** One operation in a temporary workspace, with a counter that only the command increments. */
export class GuestFixture {
  readonly ws = testkit.makeTempDir();
  readonly L = layout(this.ws);
  readonly counter = join(this.ws, "counter");
  readonly gate = join(this.ws, "gate");
  readonly hold = join(this.ws, "hold");
  readonly queueHold = join(this.ws, "queue-hold");
  readonly opId: string;

  constructor(opId = "op_test") {
    this.opId = opId;
  }

  /** A command that counts its run and waits for the gate. */
  gated(): string {
    return testkit.countingCommand(this.counter, this.gate);
  }

  /** A command that counts its run and ends. */
  quick(): string {
    return testkit.countingCommand(this.counter);
  }

  get runs(): number {
    return testkit.readCounter(this.counter);
  }

  openGate(): void {
    fs.writeFileSync(this.gate, "");
  }

  launch(cmd: string, env: Record<string, string> = {}) {
    return testkit.launchVia(this.ws, this.opId, cmd, env);
  }

  status(env: Record<string, string> = {}) {
    return testkit.statusVia(this.ws, this.opId, env);
  }

  /** How many `launching` records the journal has for the op. */
  get launchAttempts(): number {
    return testkit.readJournal(this.ws).filter((r) => r.type === "launching" && r.opId === this.opId).length;
  }

  hasClaim(): boolean {
    return fs.existsSync(this.L.claim(this.opId));
  }

  hasExit(): boolean {
    return fs.existsSync(this.L.exit(this.opId));
  }

  async untilClaimed(): Promise<void> {
    await testkit.waitFor(() => this.hasClaim(), "claim file");
  }

  async untilExit(): Promise<void> {
    await testkit.waitFor(() => this.hasExit(), "exit status");
  }

  /** Release everything and remove the files. Call it from `t.after`. */
  cleanup(): void {
    for (const f of [this.gate, this.hold, this.queueHold]) {
      try {
        fs.writeFileSync(f, "");
      } catch {
        // the workspace is gone
      }
    }
    testkit.killWorkspaceProcesses(this.ws);
    fs.rmSync(this.ws, { recursive: true, force: true });
  }
}
