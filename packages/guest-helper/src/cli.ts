/**
 * One-shot guest helper process. A test runs it as a child process and kills it
 * at a named step. A real helper is a long-lived server; this entry point has the
 * same logic and a process boundary, which is what the fault tests need.
 *
 * Usage: node cli.ts <workspace> <command> [args]
 *   launch <op_id> <incarnation> <cmd>
 *   status <op_id>
 *   reconcile
 *   handshake
 * The answer is one JSON line on stdout.
 *
 * Test-only environment:
 *   HERMESD_TEST_FAULT=<fault point>      SIGKILL this process at that point
 *   HERMESD_TEST_BOOT_ID=<id>             replace the kernel boot ID
 *   HERMESD_TEST_QUEUE_HOLD_FILE=<file>   delay the unit start until the file exists (D14 c)
 *   HERMESD_TEST_UNIT_UNREADABLE=1        unit state cannot be read
 *   HERMESD_UNIT_MANAGER=process|systemd  default: systemd only if it is PID 1
 *   HERMESD_TEST_SHIM_HOLD_FILE           read by the shim, see shim.ts
 */
import { GuestHelper, type FaultPoint } from "./helper.ts";
import { SystemdUnitManager, isSystemdPid1 } from "./systemd.ts";
import { ProcessGroupUnitManager, type UnitManager } from "./unit-manager.ts";

function pickUnits(workspace: string): UnitManager {
  const want = process.env.HERMESD_UNIT_MANAGER;
  let m: UnitManager;
  if (want === "systemd" || (want === undefined && isSystemdPid1())) {
    m = new SystemdUnitManager();
  } else {
    m = new ProcessGroupUnitManager({ workspace, queueHoldFile: process.env.HERMESD_TEST_QUEUE_HOLD_FILE });
  }
  if (process.env.HERMESD_TEST_UNIT_UNREADABLE === "1") {
    const inner = m;
    m = {
      kind: inner.kind,
      start: (s) => inner.start(s),
      query: async () => ({ alive: undefined, units: [] }),
      stop: (o) => inner.stop(o),
    };
  }
  return m;
}

const [workspace, command, ...rest] = process.argv.slice(2);
if (workspace === undefined || command === undefined) {
  console.error("usage: cli.ts <workspace> launch|status|reconcile|handshake ...");
  process.exit(2);
}

const fault = process.env.HERMESD_TEST_FAULT as FaultPoint | undefined;
const bootOverride = process.env.HERMESD_TEST_BOOT_ID;
const helper = new GuestHelper({
  workspace,
  units: pickUnits(workspace),
  ...(bootOverride ? { bootId: () => bootOverride } : {}),
  onStep: (point) => {
    if (point === fault) process.kill(process.pid, "SIGKILL");
  },
});

let result: unknown;
switch (command) {
  case "launch":
    result = await helper.launch(rest[0] as string, Number(rest[1]), rest[2] as string);
    break;
  case "status":
    result = await helper.status(rest[0] as string);
    break;
  case "reconcile":
    result = await helper.reconcile();
    break;
  case "handshake":
    result = await helper.handshake();
    break;
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
process.stdout.write(JSON.stringify(result) + "\n");
