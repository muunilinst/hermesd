/**
 * The Host interface (porting guide rev 5.1, section 4.6).
 *
 * Agent code imports this interface only. It never imports a platform SDK.
 * Each platform (in-memory Node, Durable Objects, TeenyTiny v2, Rivet) gets
 * one adapter that implements it.
 *
 * The 7 functions hide SDK syntax. They do not make the platforms equally
 * durable. The adapter rules in section 4.6 do that, and each adapter must
 * pass the fault tests in `@hermesd/faults` before it is called done.
 */

/** A SQL value that every platform SQLite can store. */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** One row that a query returns. */
export type SqlRow = Record<string, SqlValue>;

/**
 * Synchronous SQL access inside one transaction.
 *
 * The functions are synchronous on purpose. On Durable Objects and TeenyTiny
 * an `await` inside a transaction lets another event interleave (section 4.3).
 */
export interface Sql {
  exec(query: string, ...params: SqlValue[]): SqlRow[];
}

/** An RPC client for a sidecar: the gateway host or the executor. */
export interface RpcClient {
  call<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
}

/** The owner epoch. It increases at every activation of the actor. */
export type OwnerEpoch = number;

export interface Host {
  /** The session key. The platform makes sure one writer has it at a time. */
  id(): string;

  /**
   * The owner epoch. The adapter raises it in the first committed transaction
   * of each activation, before any outbound call. Every store write and every
   * executor call carries it.
   */
  epoch(): OwnerEpoch;

  /** Run `fn` as one atomic transaction over the actor's rows. */
  tx<T>(fn: (sql: Sql) => T): Promise<T>;

  /** Resolves only when every committed row is durable. */
  commit(): Promise<void>;

  /**
   * Arm a durable timer for a wake obligation. Resolves only when the timer is
   * durable. Rule: arm first, then commit the pending row (section 4.6).
   */
  arm(at: Date, key: string): Promise<void>;

  /**
   * Remove the timer of `key`: its obligation is closed. A host whose timers stay until
   * removed (a Durable Object alarm row, a Rivet schedule) must have it, or a closed
   * obligation keeps waking the actor. A key with no timer is not an error.
   */
  disarm?(key: string): Promise<void>;

  /** Outbound HTTP. The signal aborts the request and drops partial output. */
  fetch(req: Request, signal?: AbortSignal): Promise<Response>;

  /** A client for a named sidecar, such as "executor" or "gateway". */
  sidecar(name: string): RpcClient;
}
