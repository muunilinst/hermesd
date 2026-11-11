import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unitBelongsTo } from "./paths.ts";
import { parseProcStat, processMatches, readKernelBootId, readProcStat } from "./proc.ts";
import { buildSystemdRunArgs, isSystemdPid1, parseListUnits, parseShow } from "./systemd.ts";
import { needsLinux } from "./testkit.ts";

describe("proc", { skip: needsLinux }, () => {
  it("parses stat with spaces and parentheses in the command name", () => {
    const s = parseProcStat("42 (a (b) c) S 1 42 42 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 987654 1000 100 18446744073709551615");
    assert.deepEqual(s, { state: "S", startTime: "987654" });
  });

  it("reads this process and tells a dead PID", () => {
    const st = readProcStat(process.pid);
    assert.ok(st);
    assert.ok(processMatches(process.pid, st.startTime));
    assert.ok(!processMatches(process.pid, "0"));
    assert.equal(readProcStat(2 ** 22 + 12345), undefined);
  });

  it("reads a boot ID", () => {
    assert.match(readKernelBootId(), /^[0-9a-f-]{36}$/);
  });
});

describe("systemd helpers", () => {
  it("detects systemd as PID 1 only with both signs", () => {
    assert.equal(isSystemdPid1(() => "systemd\n", () => true), true);
    assert.equal(isSystemdPid1(() => "process_api\n", () => true), false);
    assert.equal(isSystemdPid1(() => "systemd\n", () => false), false);
    assert.equal(isSystemdPid1(() => { throw new Error("no /proc"); }, () => true), false);
  });

  it("builds a service start with a unit name, cgroup kill and the shim argv", () => {
    const args = buildSystemdRunArgs({ unit: "hermesd-op-x-1", opId: "x", workspace: "/ws", cmd: "echo hi" });
    assert.ok(args.includes("--unit=hermesd-op-x-1"));
    assert.ok(args.includes("--property=KillMode=control-group"));
    assert.ok(!args.includes("--scope"));
    const sep = args.indexOf("--");
    assert.ok(sep > 0);
    assert.ok(args.includes("--hermesd-unit=hermesd-op-x-1"));
    assert.equal(args.at(-1), "echo hi");
  });

  it("parses systemctl output", () => {
    const rows = parseListUnits(
      "hermesd-op-x-1.service loaded active running hermesd operation x\nhermesd-op-x-2.service loaded failed failed hermesd operation x\n",
    );
    assert.deepEqual(rows, [
      { unit: "hermesd-op-x-1", active: "active" },
      { unit: "hermesd-op-x-2", active: "failed" },
    ]);
    assert.deepEqual(parseShow("MainPID=123\nActiveState=active\n"), { MainPID: "123", ActiveState: "active" });
  });

  it("matches units of one op_id only", () => {
    assert.ok(unitBelongsTo("a", "hermesd-op-a-3"));
    assert.ok(!unitBelongsTo("a", "hermesd-op-a-1-3"));
    assert.ok(!unitBelongsTo("a", "hermesd-op-ab-3"));
  });
});
