import type { Host, SqlRow, SqlValue } from "@hermesd/host";

/**
 * The backend that the actor-side fault tests run on.
 *
 * The tests (D3, D6, D8, D9, D12, the inbox crash, the Rivet parallel test)
 * know only this interface. Each host (in-memory Node, Durable Objects,
 * TeenyTiny, Rivet) gets a binding that implements it. The Node binding is in
 * `node-backend.ts`. A binding for a real host injects the same faults by its
 * own means: a code update or a kill for a crash, a test hook for the timer.
 */

/** Named places where a fault can act. They match the adapter rules of guide section 4.6. */
export type FaultPoint =
  | "arm:before"
  | "arm:after"
  | "tx:before"
  | "tx:before-commit"
  | "tx:after"
  | "commit:before"
  | "commit:after"
  | "fetch:before"
  | "fetch:after"
  | "sidecar:before"
  | "sidecar:after"
  | "reply:before";

export interface FaultRule {
  actor: string;
  point: FaultPoint;
  /** What the actor was handling: a request, an alarm, a cron tick, or its activation. */
  event?: "call" | "alarm" | "cron" | "activate";
  method?: string;
  /** For sidecar points: `<sidecar name>.<method>`. */
  detail?: string;
  /** Act on the n-th match. Default 1. */
  nth?: number;
}

export interface ActivationHandle {
  readonly epoch: number;
  call(method: string, params?: unknown): Promise<unknown>;
}

export interface ActorBackend {
  /** A label for test names, for example "node/durable-objects". */
  readonly label: string;
  /** How the platform lets events interleave. */
  readonly interleave: "input-gate" | "every-await";
  /** Does the platform retry an alarm whose handler failed? Rivet does not. */
  readonly retriesAlarms: boolean;

  readonly clock: { now(): number; advance(ms: number): Promise<void> };

  defineActor(key: string, factory: (host: Host) => ActorBehavior): void;
  /** Platform cron: call `name` on the actor every `everyMs`. */
  cron(key: string, name: string, everyMs: number): void;
  call(key: string, method: string, params?: unknown): Promise<unknown>;
  /** Register a named sidecar, such as "executor" or "gateway". Actors reach it with `Host.sidecar(name)`. */
  registerSidecar(name: string, handler: (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>): void;
  /** Wait until no work is in flight. */
  settle(): Promise<void>;

  // Faults
  crash(key: string): void;
  crashAt(rule: FaultRule): void;
  onPoint(rule: FaultRule, hook: () => void | Promise<void>): void;
  failArm(key: string, times?: number): void;
  deleteTimer(key: string): void;
  fireTimerEarly(key: string): Promise<void>;
  /** Start a second activation while the first one still runs. */
  splitBrain(key: string): Promise<{ old: ActivationHandle; fresh: ActivationHandle }>;

  // Inspection
  alarmOf(key: string): { at: number; key: string } | null;
  query(key: string, sql: string, ...params: SqlValue[]): SqlRow[];
  epochOf(key: string): number;

  close(): void;
}

export interface ActorBehavior {
  activate?(): Promise<void>;
  alarm?(): Promise<void>;
  cron?(name: string): Promise<void>;
  call(method: string, params: unknown): Promise<unknown>;
}
