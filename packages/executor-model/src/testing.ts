import type { Executor, OpId, OpStatus } from "@hermesd/executor-protocol";
import { deriveOpId } from "@hermesd/executor-protocol";
import assert from "node:assert/strict";
import type { CommandSpec } from "./rig.ts";
import { ModelRig } from "./rig.ts";

export const TENANT = "tenant-1";

export interface PreparedOp {
  opId: OpId;
  incarnation: number;
  inputHash: string;
}

/** Start the VM through the cell, as a normal first boot. */
export async function boot(rig: ModelRig): Promise<void> {
  await rig.cell.startVm();
}

/** Describe, then prepare. The actor fixes the incarnation before prepare. */
export async function prepareOp(
  rig: ModelRig,
  ex: Executor,
  session: string,
  intent: string,
  spec: CommandSpec = {},
): Promise<PreparedOp> {
  const opId = await deriveOpId(TENANT, session, intent);
  const { incarnation } = await ex.describe(rig.workspace);
  const inputHash = `hash-${intent}`;
  const res = await ex.prepare({ opId, intentId: intent, incarnation, inputHash, cmd: rig.commands.command(spec) });
  assert.deepEqual(res, { kind: "prepared" });
  return { opId, incarnation, inputHash };
}

export function expectStatus<S extends OpStatus["status"]>(got: OpStatus, status: S): Extract<OpStatus, { status: S }> {
  assert.equal(got.status, status);
  return got as Extract<OpStatus, { status: S }>;
}
