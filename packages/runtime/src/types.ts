import type { Host, Sql } from "@hermesd/host";

/** The time source. The actor code never reads the system clock. */
export interface Clock {
  now(): number;
}

/**
 * What an adapter calls on the actor code. Each adapter has its own copy of
 * this shape. The two copies are the same, so the compiler accepts either.
 */
export interface ActorBehavior {
  activate?(): Promise<void>;
  alarm?(): Promise<void>;
  cron?(name: string): Promise<void>;
  call(method: string, params: unknown): Promise<unknown>;
}

export interface RuntimeConfig {
  /** The least time between an arm and the due time of the obligation (guide 4.6). Default 30 s. */
  minDelayMs: number;
  /** How long a turn may run before the sweeper wakes the session. Default 10 min. */
  horizonMs: number;
  /** A turn whose driver fails this many times without a recorded step ends with a visible error. Default 5. */
  maxFailuresWithoutProgress: number;
  /** The sidecar name of the sweeper actor. */
  sweeperTarget: string;
  /** The sidecar name of the profile actor, or null when there is none. */
  profileTarget: string | null;
  /** The sidecar name of a session actor. The sweeper uses it to wake sessions. */
  actorTarget(sessionId: string): string;
}

export function resolveConfig(partial: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    minDelayMs: 30_000,
    horizonMs: 600_000,
    maxFailuresWithoutProgress: 5,
    sweeperTarget: "actor:sweeper",
    profileTarget: null,
    actorTarget: (id) => `actor:${id}`,
    ...partial,
  };
}

/** A row that says "this step may be in flight". It always has a wake obligation. */
export interface PendingRow {
  id: string;
  turnId: string;
  kind: string;
  payload: unknown;
  /** How many times a wake found this row and drove it again. */
  attempts: number;
}

/** Writes outbox rows inside the same transaction as the change they describe. */
export interface OutboxWriter {
  enqueue(target: string, method: string, payload: Record<string, unknown>): void;
}

/** What the turn driver gets. Every method keeps the rules of guide section 4.6. */
export interface TurnContext {
  readonly turnId: string;
  readonly admissionId: number;
  readonly input: string;
  readonly host: Host;
  /**
   * Record the next step that may be in flight. Arms the timer first, then
   * commits the pending row and its wake obligation. Call this before you
   * send anything.
   */
  pend(kind: string, payload: unknown): Promise<PendingRow>;
  /** Record the result of a pending row. Its wake obligation is closed. */
  settle(pendingId: string, result: unknown): Promise<void>;
  /** Run one atomic transaction and commit it. Use `outbox` for changes that other actors must see. */
  write<T>(fn: (sql: Sql, outbox: OutboxWriter) => T): Promise<T>;
  /** Add a message to the transcript. With `expectedTail`, it fails if another message came first. */
  appendMessage(role: string, text: string, opts?: { expectedTail?: number }): Promise<AppendResult>;
  /** End the turn. The admission becomes terminal and the sweeper gets a close. */
  finish(status: "done" | "failed", text: string): Promise<void>;
}

export interface AppendResult {
  ok: boolean;
  /** The sequence number of the new message, when ok. */
  seq?: number;
  /** The current last sequence number. */
  tail: number;
}

/**
 * The application part of a turn: the model call, the tools. The runtime
 * decides when each method runs. The driver must write a pending row (with
 * `ctx.pend`) before any step that may have an effect.
 */
export interface TurnDriver {
  /** First run of a turn. Also used again if a crash left the turn with no recorded step. */
  start(ctx: TurnContext): Promise<void>;
  /** A wake found these pending rows without a result. Treat them as "may have been sent". */
  resume(ctx: TurnContext, pending: PendingRow[]): Promise<void>;
}

/** A cron job. It runs inside the transaction that closes its obligation, so it runs once. */
export type JobFn = (sql: Sql, outbox: OutboxWriter, info: { obligationId: string }) => void;

export interface SessionDeps {
  clock: Clock;
  driver: TurnDriver;
  config?: Partial<RuntimeConfig>;
  jobs?: Record<string, JobFn>;
}

export interface ReceiveParams {
  principal: string;
  session: string;
  request: string;
  input: string;
}

export interface ReceiveResult {
  admissionId: number;
  status: string;
  /** True if the same (principal, session, request) was admitted before. */
  duplicate: boolean;
}
