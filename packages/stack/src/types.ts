import type { SqlRow } from "@hermesd/host";
import type { ModelStep } from "@hermesd/session-actor";

/**
 * One deployment of the milestone 1 world on one host: a session actor `s1`, the
 * sweeper, the profile actor, the executor (the in-memory executor model), a gateway
 * that receives the replies, and a scripted model behind `Host.fetch`.
 *
 * The same scenarios and the same bench run on every host through this interface:
 * the in-memory Node simulator, real workerd (Durable Objects, through Miniflare)
 * and real rivetkit. None of them is a real deployment, so a pass here does not make
 * a mechanism demonstrated (STATUS.md).
 */
export type StackHost = "node" | "workerd" | "rivet";

/** The actors of the world. */
export type ActorName = "s1" | "sweeper" | "profile";

export interface StackOptions {
  /** The scripted model steps, in order. A re-sent request with the same call id gets the same step. */
  script: ModelStep[];
  /** Added latency of each model answer, in ms, so a turn has the shape of a real one. Default 0. */
  modelDelayMs?: number;
  /** The least delay of a wake obligation. Small on real hosts so a test waits seconds, not 30 s. Default 1000. */
  minDelayMs?: number;
  /** How long a turn may run before the sweeper wakes the session. Default 10000. */
  horizonMs?: number;
}

/** A reply that reached the gateway. Each idempotency key once. */
export interface StackReply {
  text: string;
  kind: string;
  turn: string;
  key: string;
}

/** A place in a Host call where a crash can be injected (a subset of the Node fault points). */
export type StackFaultPoint =
  | "tx:before"
  | "tx:after"
  | "commit:before"
  | "commit:after"
  | "arm:before"
  | "arm:after"
  | "fetch:before"
  | "fetch:after"
  | "sidecar:before"
  | "sidecar:after";

export interface StackFaultRule {
  actor: ActorName;
  point: StackFaultPoint;
  /** For sidecar points: `<sidecar name>.<method>`, for example `actor:profile.index`. */
  detail?: string;
  /** Act on the n-th match (1-based). Default 1. Each rule acts once. */
  nth?: number;
}

/** What one actor did, counted at the Host interface. */
export interface MeterSnapshot {
  /** Activations (owner epochs raised) since the meter was reset. */
  activations: number;
  /** Events that reached the actor: calls, alarms, crons. */
  events: number;
  /** Transactions. */
  tx: number;
  /** SQL statements run inside transactions. */
  statements: number;
  /** Rows that SQLite reports as changed (`total_changes()`), or -1 if the host does not give it. */
  rowsChanged: number;
  /** `commit()` calls, each one a wait for durability. */
  commits: number;
  arms: number;
  disarms: number;
  /** Outbound fetches (model calls). */
  fetches: number;
  /** Sidecar calls by `<name>.<method>`. */
  sidecars: Record<string, number>;
  /**
   * Wall time with at least one event, commit, arm, fetch or sidecar call in flight, in ms.
   * It is the time a platform that bills for duration while a request or its I/O is open
   * would count. Time between turns is not in it.
   */
  busyMs: number;
  /** The same, without the time spent waiting for the model (`fetch`). */
  busyExclModelMs: number;
}

/** When the model saw each request, by wall time in ms since the epoch. */
export interface ModelArrival {
  at: number;
  callId: string | null;
}

export interface Stack {
  readonly host: StackHost;
  /** Send one user input to `s1`. Resolves when the admission is durable (the receive call returned). */
  send(input: string, request?: string): Promise<void>;
  /** Replies received so far. */
  replies(): Promise<StackReply[]>;
  /** Wait until at least `n` replies arrived. Rejects after `timeoutMs` (default 30000). */
  waitReplies(n: number, timeoutMs?: number): Promise<StackReply[]>;
  /** Call a method on an actor, as another actor or the gateway would. */
  call(actor: ActorName, method: string, params?: unknown): Promise<unknown>;
  /** Run a read-only query on an actor's rows. */
  rows(actor: ActorName, sql: string): Promise<SqlRow[]>;
  /** The platform throws the actor out of memory, as a crash or an eviction does. The next event activates it again. */
  evict(actor: ActorName): Promise<void>;
  /** Crash the actor at a Host fault point, once. */
  crashAt(rule: StackFaultRule): Promise<void>;
  /** Open the gate `name`: a held model step (`hold` in the script) and a held scripted command. */
  release(name: string): Promise<void>;
  /** Run the sweeper's cron job now (`tick` or `sweep`). Real platforms run it on a schedule. */
  cron(name: "tick" | "sweep"): Promise<void>;
  /** The meter of an actor. */
  meter(actor: ActorName): Promise<MeterSnapshot>;
  resetMeters(): Promise<void>;
  /** Every request the model received, in order. */
  modelArrivals(): Promise<ModelArrival[]>;
  /** Commands the executor started. */
  executorRuns(): Promise<number>;
  close(): Promise<void>;
}

export type StackFactory = (opts: StackOptions) => Promise<Stack>;
