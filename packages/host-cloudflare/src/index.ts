/**
 * The Durable Objects adapter for the Host interface (porting guide rev 5.1,
 * sections 4.3 and 4.6).
 *
 * TeenyTiny v2 implements the Durable Objects API, so the same file is the
 * start point for the TeenyTiny adapter. See NOTES.md for the differences to
 * check.
 *
 * This file does not import `@cloudflare/workers-types`. It uses small
 * structural types for the parts of `DurableObjectState` that it needs. A real
 * `ctx` fits them, and a fake `ctx` in a unit test fits them too.
 *
 * Usage in a Durable Object class:
 *
 *     class Session extends DurableObject {
 *       host = new CloudflareHost(this.ctx, { sidecars: { executor: this.env.EXECUTOR } });
 *       async alarm() { await this.host.handleAlarm(); }
 *     }
 */
import type { Host, OwnerEpoch, RpcClient, Sql, SqlRow, SqlValue } from "@hermesd/host";

/** The part of a SQL cursor that the adapter uses. */
export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
}

/** The part of `DurableObjectStorage` that the adapter uses. */
export interface StorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursorLike };
  transactionSync<T>(fn: () => T): T;
  sync(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

/** The part of `DurableObjectState` that the adapter uses. */
export interface StateLike {
  id: { name?: string | undefined; toString(): string };
  storage: StorageLike;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/** A service binding, or any object with a `fetch` method. */
export interface FetcherLike {
  fetch(req: Request): Promise<Response>;
}

export interface CloudflareHostOptions {
  /** Outbound fetch. The default is the global `fetch`. */
  fetch?: (req: Request) => Promise<Response>;
  /** Sidecars by name, for example `{ executor: env.EXECUTOR }`. */
  sidecars?: Record<string, FetcherLike>;
  /** Clock in ms. The default is `Date.now`. Tests replace it. */
  now?: () => number;
  /** Delay for a retry alarm when due work is still open. Default 60000 ms. */
  retryDelayMs?: number;
}

/** Called when the alarm fires. `keys` are the due obligations. */
export type AlarmHandler = (keys: string[]) => Promise<void>;

/** A sidecar answered with a status that is not 2xx. */
export class SidecarError extends Error {
  readonly status: number;
  constructor(name: string, method: string, status: number, body: string) {
    super(`sidecar ${name} ${method} failed with status ${status}: ${body.slice(0, 200)}`);
    this.name = "SidecarError";
    this.status = status;
  }
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS host_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS wake_timers (key TEXT PRIMARY KEY, due_ms INTEGER NOT NULL)",
];

/** Binary values come back from Durable Objects as ArrayBuffer. Host uses Uint8Array. */
function normalizeRow(row: Record<string, unknown>): SqlRow {
  const out: SqlRow = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SqlValue);
  }
  return out;
}

export class CloudflareHost implements Host {
  readonly #ctx: StateLike;
  readonly #opts: CloudflareHostOptions;
  readonly #now: () => number;
  #epoch: OwnerEpoch | undefined;
  #alarmHandler: AlarmHandler | undefined;

  /** Resolves when the epoch is raised and durable. Rejects if activation fails. */
  readonly ready: Promise<void>;

  /**
   * Call this in the Durable Object constructor. It starts
   * `blockConcurrencyWhile`, so no event runs before the epoch is raised.
   */
  constructor(ctx: StateLike, opts: CloudflareHostOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.#epoch = ctx.storage.transactionSync(() => {
        for (const stmt of SCHEMA) ctx.storage.sql.exec(stmt);
        ctx.storage.sql.exec(
          "INSERT INTO host_meta (k, v) VALUES ('owner_epoch', 1) " +
            "ON CONFLICT (k) DO UPDATE SET v = v + 1",
        );
        const rows = ctx.storage.sql.exec("SELECT v FROM host_meta WHERE k = 'owner_epoch'").toArray();
        return Number(rows[0]?.["v"]);
      });
      // The epoch must be durable before any outbound call.
      await ctx.storage.sync();
    });
  }

  id(): string {
    return this.#ctx.id.name ?? this.#ctx.id.toString();
  }

  epoch(): OwnerEpoch {
    if (this.#epoch === undefined) {
      throw new Error("epoch() called before activation finished");
    }
    return this.#epoch;
  }

  /**
   * Run `fn` in `transactionSync`. `fn` must be synchronous. If it throws or
   * returns a promise, the transaction rolls back.
   */
  async tx<T>(fn: (sql: Sql) => T): Promise<T> {
    const storage = this.#ctx.storage;
    const sql: Sql = {
      exec: (query, ...params) => storage.sql.exec(query, ...params).toArray().map(normalizeRow),
    };
    return storage.transactionSync(() => {
      const result = fn(sql);
      if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("tx callback must be synchronous: an await would let other events interleave");
      }
      return result;
    });
  }

  /** Resolves when all committed writes are durable. */
  async commit(): Promise<void> {
    await this.#ctx.storage.sync();
  }

  /**
   * Keep the obligation in `wake_timers`, set the one alarm to the earliest
   * due time, then wait for `sync()`.
   *
   * ASSUMED, not documented by Cloudflare (guide open question 6): after
   * `setAlarm()` and `sync()` resolve, the alarm is durable before a later SQL
   * commit. TeenyTiny documents this for its own alarm.
   */
  async arm(at: Date, key: string): Promise<void> {
    const storage = this.#ctx.storage;
    storage.transactionSync(() => {
      storage.sql.exec(
        "INSERT INTO wake_timers (key, due_ms) VALUES (?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET due_ms = excluded.due_ms",
        key,
        at.getTime(),
      );
    });
    await this.#setAlarmToEarliest(false);
  }

  /** Remove an obligation after its work is done. Not part of Host. */
  async disarm(key: string): Promise<void> {
    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec("DELETE FROM wake_timers WHERE key = ?", key);
    });
    await this.#setAlarmToEarliest(false);
  }

  /** The runtime sets the function that runs when an obligation is due. */
  onAlarm(handler: AlarmHandler): void {
    this.#alarmHandler = handler;
  }

  /**
   * Call this from the class `alarm()` method.
   *
   * First durable action: arm the next alarm (the earliest later obligation, or
   * a retry if due work is still open). Only then call the handler. Due rows
   * stay until the runtime calls `disarm(key)`, so a handler that throws is
   * retried by the platform. An empty due list means an early alarm, and it is
   * not an error.
   */
  async handleAlarm(): Promise<string[]> {
    const now = this.#now();
    const due = this.#ctx.storage.sql
      .exec("SELECT key FROM wake_timers WHERE due_ms <= ? ORDER BY due_ms, key", now)
      .toArray()
      .map((r) => String(r["key"]));
    await this.#setAlarmToEarliest(due.length > 0);
    if (due.length > 0 && this.#alarmHandler) await this.#alarmHandler(due);
    return due;
  }

  /**
   * Set the alarm to the earliest row. If `retryOpen` is true, set it to the
   * earliest row that is still in the future, or to a retry time if there is
   * none.
   */
  async #setAlarmToEarliest(retryOpen: boolean): Promise<void> {
    const storage = this.#ctx.storage;
    const now = this.#now();
    let next: number | null;
    if (retryOpen) {
      const later = storage.sql
        .exec("SELECT MIN(due_ms) AS m FROM wake_timers WHERE due_ms > ?", now)
        .toArray()[0]?.["m"];
      const retryAt = now + (this.#opts.retryDelayMs ?? 60_000);
      next = later === null || later === undefined ? retryAt : Math.min(Number(later), retryAt);
    } else {
      const min = storage.sql.exec("SELECT MIN(due_ms) AS m FROM wake_timers").toArray()[0]?.["m"];
      next = min === null || min === undefined ? null : Number(min);
    }
    if (next === null) {
      await storage.deleteAlarm();
    } else {
      await storage.setAlarm(next);
    }
    await storage.sync();
  }

  /** Outbound HTTP. The signal aborts the request. */
  async fetch(req: Request, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    const doFetch = this.#opts.fetch ?? ((r: Request) => globalThis.fetch(r));
    return doFetch(signal ? new Request(req, { signal: AbortSignal.any([signal, req.signal]) }) : req);
  }

  /**
   * A client for a sidecar. It sends `POST http://sidecar/rpc` with a JSON body
   * `{ method, params }` and the header `x-hermesd-epoch`. The sidecar answers
   * with the JSON result. A status that is not 2xx throws `SidecarError`.
   */
  sidecar(name: string): RpcClient {
    return {
      call: async <T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
        const binding = this.#opts.sidecars?.[name];
        if (!binding) throw new Error(`no sidecar binding named ${name}`);
        const req = new Request("http://sidecar/rpc", {
          method: "POST",
          headers: { "content-type": "application/json", "x-hermesd-epoch": String(this.epoch()) },
          body: JSON.stringify({ method, params }),
          ...(signal ? { signal } : {}),
        });
        const res = await binding.fetch(req);
        if (!res.ok) throw new SidecarError(name, method, res.status, await res.text());
        return (await res.json()) as T;
      },
    };
  }
}
