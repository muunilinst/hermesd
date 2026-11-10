import { deriveOpId } from "@hermesd/executor-protocol";
import type { Command, OpId } from "@hermesd/executor-protocol";
import { ModelRig } from "@hermesd/executor-model";
import type { FaultLink } from "@hermesd/executor-model";
import type { CommandSpec, FaultBackend, FaultWorld, FaultableExecutor, VmControls, Via, VmInfo } from "./backend.ts";

const TENANT = "tenant-1";

function faultable(link: FaultLink): FaultableExecutor {
  return Object.assign(link, {
    copyOfLast: (method: Parameters<FaultLink["lastSent"]>[0]) => link.copy(link.lastSent(method).index),
  }) as unknown as FaultableExecutor;
}

/**
 * The binding to the in-memory reference model (`@hermesd/executor-model`).
 *
 * A pass here shows that the tests and the model agree. It does not
 * demonstrate the mechanism: the guest, the VM and the cell are simulated.
 */
export const modelBackend: FaultBackend = {
  name: "model",
  async create(): Promise<FaultWorld> {
    const rig = new ModelRig();

    const direct = (via: Via, viaExecutor: () => Promise<void>, viaVm: () => void): Promise<void> =>
      via === "executor" ? viaExecutor() : Promise.resolve().then(viaVm);

    const vm: VmControls = {
      async info(): Promise<VmInfo> {
        const p = rig.vm.peek();
        return { runId: p.runId, revision: p.revision, saveId: p.save.id, lineage: p.save.lineage, status: p.status, journalSeq: p.journalSeq };
      },
      start: (via) => direct(via, () => rig.cell.startVm(), () => void rig.vm.start()),
      stop: (via) => direct(via, () => rig.cell.stopVm(), () => void rig.vm.stop()),
      restoreDisks: (id, via) => direct(via, () => rig.cell.restoreDisks(id), () => rig.vm.restoreDisks(id)),
      replaceImage: (via) => direct(via, () => rig.cell.replaceImage(), () => rig.vm.replaceImage()),
      discard: (via) => direct(via, () => rig.cell.discard(), () => rig.vm.discard()),
      markRecoveryRequired: async () => rig.vm.markRecoveryRequired(),
      recover: (via) => direct(via, () => rig.cell.recover(), () => rig.vm.recover()),
    };

    return {
      backend: "model",
      workspace: rig.workspace,
      executor: () => faultable(rig.link()),
      opId: (session, intentId): Promise<OpId> => deriveOpId(TENANT, session, intentId),
      command: (spec?: CommandSpec): Command => rig.commands.command(spec),
      async release(key) {
        rig.commands.release(key);
        await rig.settle();
      },
      async runCount(opId) {
        return rig.runCount(opId);
      },
      pause: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1))),
      vm,
      cell: {
        async crash() {
          rig.cell.crash();
        },
        async restart() {
          await rig.cell.restart();
        },
        async failover() {
          await rig.failover();
        },
      },
      async close() {},
    };
  },
};
