import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { layout } from "./paths.ts";
import { SHIM_PATH } from "./unit-manager.ts";
import { countingCommand, makeTempDir, needsLinux, readCounter, shq, waitFor } from "./testkit.ts";

function runShim(ws: string, op: string, unit: string, cmd: string, env: Record<string, string> = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SHIM_PATH, `--hermesd-unit=${unit}`, `--workspace=${ws}`, `--op=${op}`, "--", cmd], {
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    c.on("close", (code) => resolve(code));
  });
}

describe("shim", { skip: needsLinux }, () => {
  it("claims, runs the command, writes output and exit status", async () => {
    const ws = makeTempDir();
    const L = layout(ws);
    assert.equal(await runShim(ws, "op1", "hermesd-op-op1-1", "echo out; echo err >&2; exit 3"), 0);
    assert.ok(fs.existsSync(L.claim("op1")));
    assert.equal(fs.readFileSync(L.stdout("op1"), "utf8"), "out\n");
    assert.equal(fs.readFileSync(L.stderr("op1"), "utf8"), "err\n");
    assert.equal(JSON.parse(fs.readFileSync(L.exit("op1"), "utf8")).code, 3);
  });

  it("exits at once and runs nothing when the claim exists", async () => {
    const ws = makeTempDir();
    const counter = join(ws, "counter");
    assert.equal(await runShim(ws, "op1", "hermesd-op-op1-1", countingCommand(counter)), 0);
    assert.equal(await runShim(ws, "op1", "hermesd-op-op1-2", countingCommand(counter)), 0);
    assert.equal(readCounter(counter), 1);
    assert.ok(fs.existsSync(layout(ws).lost("op1", "hermesd-op-op1-2")));
  });

  it("runs nothing before the claim: a held shim has not run the command", async () => {
    const ws = makeTempDir();
    const counter = join(ws, "counter");
    const hold = join(ws, "hold");
    const p = runShim(ws, "op1", "hermesd-op-op1-1", countingCommand(counter), { HERMESD_TEST_SHIM_HOLD_FILE: hold });
    await waitFor(() => fs.existsSync(`${hold}.reached`), "shim at hold");
    assert.equal(fs.existsSync(layout(ws).claim("op1")), false);
    assert.equal(readCounter(counter), 0);
    fs.writeFileSync(hold, "");
    await p;
    assert.equal(readCounter(counter), 1);
  });

  it("records a signal exit as a null code", async () => {
    const ws = makeTempDir();
    await runShim(ws, "op1", "hermesd-op-op1-1", `kill -9 $$; sleep 1 # ${shq("x")}`);
    const x = JSON.parse(fs.readFileSync(layout(ws).exit("op1"), "utf8"));
    assert.equal(x.code, null);
    assert.equal(x.signal, "SIGKILL");
  });
});
