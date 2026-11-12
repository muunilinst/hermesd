import { NodePlatform, type PlatformMode } from "@hermesd/host-node";
import type { ActorBackend } from "./backend.ts";

export interface NodeBackendOptions {
  mode: PlatformMode;
  /** Override the retry rule of the mode. Used to test the "failed run is not retried" case on both modes. */
  retryFailedAlarms?: boolean;
  /** Handles `Host.fetch`: the model of the loop tests. */
  fetch?: (req: Request, signal?: AbortSignal) => Promise<Response>;
}

/** The Node binding of the actor backend: the in-memory platform of `@hermesd/host-node`. */
export function createNodeBackend(options: NodeBackendOptions): ActorBackend & { platform: NodePlatform } {
  const platform = new NodePlatform({
    mode: options.mode,
    ...(options.retryFailedAlarms !== undefined ? { retryFailedAlarms: options.retryFailedAlarms } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const retries = options.retryFailedAlarms ?? options.mode === "durable-objects";
  return {
    platform,
    label: `node/${options.mode}${retries ? "" : "/no-alarm-retry"}`,
    interleave: options.mode === "durable-objects" ? "input-gate" : "every-await",
    retriesAlarms: retries,
    clock: platform.clock,
    defineActor: (key, factory) => platform.defineActor(key, factory),
    cron: (key, name, everyMs) => platform.cron(key, name, everyMs),
    call: (key, method, params) => platform.call(key, method, params),
    registerSidecar: (name, handler) => platform.registerSidecar(name, handler),
    settle: () => platform.idle(),
    crash: (key) => platform.crash(key),
    crashAt: (rule) => platform.crashAt(rule),
    onPoint: (rule, hook) => platform.onPoint(rule, hook),
    failArm: (key, times) => platform.failArm(key, times),
    deleteTimer: (key) => platform.deleteTimer(key),
    fireTimerEarly: (key) => platform.fireTimerEarly(key),
    splitBrain: (key) => platform.splitBrain(key),
    alarmOf: (key) => platform.alarmOf(key),
    query: (key, sql, ...params) => platform.query(key, sql, ...params),
    epochOf: (key) => platform.epochOf(key),
    close: () => platform.close(),
  };
}

/** The Node configurations that every actor-side test runs on. */
export const NODE_CONFIGS: ReadonlyArray<NodeBackendOptions> = [{ mode: "durable-objects" }, { mode: "rivet" }];
