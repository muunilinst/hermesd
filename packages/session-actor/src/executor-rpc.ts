import type { RpcClient } from "@hermesd/host";
import type { Executor, OpId, OwnerEpoch } from "@hermesd/executor-protocol";

/**
 * The executor over `Host.sidecar("executor")`.
 *
 * The wire form is one RPC method for each method of the `Executor`
 * interface, with the arguments as one named object. `prepare` carries the
 * `session` (the fence and the minimum epoch are per session).
 */

export type ExecutorMethod = "prepare" | "start" | "status" | "cancel" | "ack" | "fence" | "describe";

/** The client side: an `Executor` that calls a sidecar. */
export function rpcExecutor(client: RpcClient, signal?: AbortSignal): Executor {
  return {
    prepare: (req) => client.call("prepare", req, signal),
    start: (opId, ownerEpoch) => client.call("start", { opId, ownerEpoch }, signal),
    status: (opId) => client.call("status", { opId }, signal),
    cancel: (opId, ownerEpoch) => client.call("cancel", { opId, ownerEpoch }, signal),
    ack: (opId, ownerEpoch) => client.call("ack", { opId, ownerEpoch }, signal),
    fence: (session, ownerEpoch) => client.call("fence", { session, ownerEpoch }, signal),
    describe: (workspace) => client.call("describe", { workspace }, signal),
  };
}

/** The server side: a sidecar handler that forwards the wire form to an `Executor`. */
export function executorHandler(executor: Executor): (method: string, params: unknown) => Promise<unknown> {
  return async (method, params) => {
    const p = params as { opId: OpId; ownerEpoch: OwnerEpoch; session: string; workspace: string };
    switch (method as ExecutorMethod) {
      case "prepare":
        return executor.prepare(params as Parameters<Executor["prepare"]>[0]);
      case "start":
        return executor.start(p.opId, p.ownerEpoch);
      case "status":
        return executor.status(p.opId);
      case "cancel":
        return executor.cancel(p.opId, p.ownerEpoch);
      case "ack":
        return executor.ack(p.opId, p.ownerEpoch);
      case "fence":
        return executor.fence(p.session, p.ownerEpoch);
      case "describe":
        return executor.describe(p.workspace);
      default:
        throw new Error(`executor: unknown method ${method}`);
    }
  };
}
