/**
 * The Rivet Actors adapter for the Host interface (porting guide rev 5.1,
 * sections 4.4 to 4.6), on the Rivet 3.0 APIs.
 *
 * It uses none of the APIs that 3.0 deprecated: not `c.state`, not queues, not
 * KV, and not a plain `run` function. Durable data is the per-actor SQLite
 * (`c.db`). Timers are `c.schedule`. The turn is a background task that
 * `onWake` starts inside `c.keepAwake`.
 *
 * This file does not import `rivetkit`. It uses small structural types for the
 * parts of the actor context that it needs. A real context fits them, and a
 * fake context in a unit test fits them too.
 *
 * Why a mirror: `c.db` is async only, but `Host.tx` runs a synchronous
 * callback. So the adapter keeps a copy of the actor's tables in memory
 * (`node:sqlite`), runs each `tx` on the copy (atomic, because the callback is
 * synchronous), and replays the changing statements in one `c.db.transaction`.
 * `tx` resolves only after that transaction is durable. An action that
 * interleaves sees the copy, so it sees the same rows that the durable store
 * will hold when the replay ends. If a replay fails, the adapter is broken
 * and every later call throws (the actor must restart).
 *
 * Usage in an actor:
 *
 *     actor({
 *       db: db(),
 *       options: { sleepTimeout: 30_000 },
 *       onWake: async (c) => {
 *         const host = await RivetHost.activate(c);   // raises the epoch
 *         host.startTask("turn", (signal) => runTurns(host, signal));
 *       },
 *       actions: {
 *         hostWake: async (c, key: string) => { await RivetHost.of(c).handleWake(key); },
 *         receive: async (c, msg) => { await RivetHost.of(c).tx(...); return "ok"; },
 *       },
 *     });
 */
import { DatabaseSync } from "node:sqlite";
import type { Host, OwnerEpoch, RpcClient, Sql, SqlRow, SqlValue } from "@hermesd/host";

/** The part of the `c.db` client that the adapter uses. */
export interface DbLike {
  execute(query: string, ...args: unknown[]): Promise<Record<string, unknown>[]>;
  transaction<T>(cb: (tx: DbLike) => Promise<T> | T, options?: { name?: string }): Promise<T>;
}

/** The part of the actor context that the adapter uses. */
export interface ActorLike {
  actorId: string;
  key: string[];
  db: DbLike;
  schedule: {
    at(timestamp: number, action: string, ...args: unknown[]): Promise<string>;
    cancel(id: string): Promise<boolean>;
  };
  keepAwake<T>(promise: Promise<T>): Promise<T>;
  abortSignal: AbortSignal;
}

/** A service binding, or any object with a `fetch` method. */
export interface FetcherLike {
  fetch(req: Request): Promise<Response>;
}

export interface RivetHostOptions {
  /** Outbound fetch. The default is the global `fetch`. */
  fetch?: (req: Request) => Promise<Response>;
  /** Sidecars by name: a base URL, or an object with `fetch`. */
  sidecars?: Record<string, string | FetcherLike>;
  /** Clock in ms. The default is `Date.now`. Tests replace it. */
  now?: () => number;
  /** Delay for a retry timer when due work is still open. Default 60000 ms. */
  retryDelayMs?: number;
  /** The name of the actor action that receives timer fires. Default "hostWake". */
  wakeAction?: string;
  /** Called when a background task throws. */
  onTaskError?: (name: string, error: unknown) => void;
  /**
   * Called for each write the adapter itself makes: `"row"` for a row of `host_meta` or
   * `wake_timers`, `"timer"` for `schedule.at` and `schedule.cancel`. For metering.
   */
  onWrite?: (kind: "row" | "timer") => void;
}

/** Called when an obligation is due. */
export type WakeHandler = (keys: string[]) => Promise<void>;

/** A sidecar answered with a status that is not 2xx. */
export class SidecarError extends Error {
  readonly status: number;
  constructor(name: string, method: string, status: number, body: string) {
    super(`sidecar ${name} ${method} failed with status ${status}: ${body.slice(0, 200)}`);
    this.name = "SidecarError";
    this.status = status;
  }
}

/** A newer activation owns the store. This one must stop. */
export class FencedError extends Error {
  constructor(mine: number, stored: number) {
    super(`owner epoch ${mine} is fenced: the store holds epoch ${stored}`);
    this.name = "FencedError";
  }
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS host_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
  // due_ms: when the obligation is due. fire_ms and schedule_id: the platform timer.
  "CREATE TABLE IF NOT EXISTS wake_timers (key TEXT PRIMARY KEY, due_ms INTEGER NOT NULL, " +
    "fire_ms INTEGER NOT NULL, schedule_id TEXT)",
];

interface Statement {
  q: string;
  p: SqlValue[];
}

const hosts = new Map<string, RivetHost>();

export class RivetHost implements Host {
  readonly #c: ActorLike;
  readonly #opts: RivetHostOptions;
  readonly #now: () => number;
  readonly #mirror = new DatabaseSync(":memory:");
  readonly #tasks = new Map<string, Promise<void>>();
  #chain: Promise<void> = Promise.resolve();
  #broken: unknown;
  #closed = false;
  #epoch: OwnerEpoch | undefined;
  #handler: WakeHandler | undefined;

  private constructor(c: ActorLike, opts: RivetHostOptions) {
    this.#c = c;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Call this first in `onWake`. It loads the mirror, creates the host tables,
   * and raises `owner_epoch` in the first committed write. It resolves when
   * that write is durable.
   */
  static async activate(c: ActorLike, opts: RivetHostOptions = {}): Promise<RivetHost> {
    const host = new RivetHost(c, opts);
    await host.#load();
    opts.onWrite?.("row");
    const epoch = await host.tx((sql) => {
      for (const stmt of SCHEMA) sql.exec(stmt);
      sql.exec(
        "INSERT INTO host_meta (k, v) VALUES ('owner_epoch', 1) ON CONFLICT (k) DO UPDATE SET v = v + 1",
      );
      return Number(sql.exec("SELECT v FROM host_meta WHERE k = 'owner_epoch'")[0]?.["v"]);
    });
    host.#epoch = epoch;
    hosts.set(c.actorId, host);
    return host;
  }

  /**
   * Call this when the activation stops (`onSleep`). It removes this host from the registry that `of`
   * reads, but only if the registered host is this one (a replacement activation may have registered
   * itself), and closes the in-memory mirror. Calls on this host after `close` fail.
   */
  close(): void {
    if (hosts.get(this.#c.actorId) === this) hosts.delete(this.#c.actorId);
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#mirror.close();
    } catch {
      // Already closed.
    }
  }

  /** The host of the running actor. Use it inside actions. */
  static of(c: Pick<ActorLike, "actorId">): RivetHost {
    const host = hosts.get(c.actorId);
    if (!host) throw new Error("RivetHost.activate has not run for this actor");
    return host;
  }

  /**
   * Copy every table and index of `c.db` into the mirror.
   *
   * Two SQLite details matter here:
   * - A virtual table (FTS5, FTS4) makes its own shadow tables when it is
   *   created. So the load creates the virtual table, does not replay the
   *   shadow table definitions, and then copies every shadow row exactly as
   *   stored: the text, the index, and what `SELECT *` does not show (an
   *   FTS4 `languageid`, an FTS5 locale). Nothing is parsed from the options
   *   and nothing is rebuilt, so self-contained, external content and
   *   contentless tables load the same way. SQLite refuses writes to shadow
   *   tables in defensive mode, so the mirror turns it off for this copy only.
   * - `sqlite_sequence` holds the AUTOINCREMENT high-water marks. The load
   *   copies them, so the mirror never gives out an id that `c.db` already
   *   used. Otherwise the replay of an insert gets a different id in `c.db`.
   */
  async #load(): Promise<void> {
    const objects = await this.#c.db.execute(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 6) <> '_rivet' " +
        "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name",
    );
    const isVirtual = (o: Record<string, unknown>): boolean => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(o["sql"]));
    // `PRAGMA table_list` names the shadow tables (a name check would also match an ordinary table
    // such as an external content table named `notes_segments`). The ordinary tables go first: an
    // FTS4 external content table must exist before its virtual table is created.
    // An SQLite before 3.37 has no table_list: it throws, or (an unknown pragma) returns no rows.
    // A real table_list always lists sqlite_schema, so an empty answer means the pragma is missing.
    let listed: Record<string, unknown>[] = [];
    try {
      listed = await this.#c.db.execute("PRAGMA table_list");
    } catch {
      listed = [];
    }
    if (listed.length === 0) listed = shadowsInScratch(objects, isVirtual);
    const shadowNames = new Set(listed.filter((r) => r["type"] === "shadow" && r["schema"] === "main").map((r) => String(r["name"])));
    const isShadow = (name: string): boolean => shadowNames.has(name);
    const tables = objects.filter((o) => o["type"] === "table");
    for (const o of [...tables.filter((x) => !isVirtual(x)), ...tables.filter(isVirtual), ...objects.filter((o) => o["type"] !== "table")]) {
      if (o["type"] === "table" && isShadow(String(o["name"]))) continue;
      this.#mirror.exec(String(o["sql"]));
    }
    // The tables are copied by name, so a row can arrive before the row its foreign key points at.
    // The stored rows already met their keys: turn enforcement off for the copy and check once after.
    this.#mirror.exec("PRAGMA foreign_keys = OFF");
    try {
      for (const o of objects.filter((x) => x["type"] === "table" && !isVirtual(x))) {
        const name = String(o["name"]);
        // The virtual table owns its shadow tables. The loop below fills them through it.
        if (isShadow(name)) continue;
        for (const row of await this.#c.db.execute(`SELECT * FROM "${name}"`)) this.#insert(name, row);
      }
    } finally {
      this.#mirror.exec("PRAGMA foreign_keys = ON");
    }
    const broken = this.#mirror.prepare("PRAGMA foreign_key_check").all();
    if (broken.length > 0) throw new Error(`RivetHost: the stored rows break a foreign key in "${String(broken[0]!["table"])}"`);
    const shadows = objects.filter((x) => x["type"] === "table" && isShadow(String(x["name"]))).map((x) => String(x["name"]));
    if (shadows.length > 0) {
      const mirror = this.#mirror as DatabaseSync & { enableDefensive?: (on: boolean) => void };
      if (typeof mirror.enableDefensive !== "function") {
        throw new Error("RivetHost: this runtime's node:sqlite has no enableDefensive, so FTS shadow tables cannot be copied");
      }
      mirror.enableDefensive(false);
      try {
        for (const name of shadows) {
          // Creating the virtual table already wrote rows here (FTS5 writes its version to _config).
          this.#mirror.exec(`DELETE FROM "${name}"`);
          for (const row of await this.#c.db.execute(`SELECT * FROM "${name}"`)) this.#insert(name, row);
        }
      } finally {
        mirror.enableDefensive(true);
      }
    }
    const hasSequence = await this.#c.db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'");
    if (hasSequence.length > 0) {
      for (const row of await this.#c.db.execute("SELECT name, seq FROM sqlite_sequence")) {
        const name = row["name"] as SqlValue;
        const seq = row["seq"] as SqlValue;
        const updated = this.#mirror.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?").run(seq, name);
        if (Number(updated.changes) === 0) this.#mirror.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(name, seq);
      }
    }
  }

  #insert(table: string, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    this.#mirror
      .prepare(`INSERT INTO "${table}" (${cols.map((x) => `"${x}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...(Object.values(row).map(blobOf) as SqlValue[]));
  }

  id(): string {
    return this.#c.key.join("/") || this.#c.actorId;
  }

  epoch(): OwnerEpoch {
    if (this.#epoch === undefined) throw new Error("epoch() called before activation finished");
    return this.#epoch;
  }

  /**
   * Run `fn` as one atomic transaction. `fn` is synchronous, so no other
   * action runs inside it. The result comes back after the changing
   * statements are durable in `c.db`.
   */
  async tx<T>(fn: (sql: Sql) => T): Promise<T> {
    if (this.#broken) throw this.#broken;
    const journal: Statement[] = [];
    const sql: Sql = {
      exec: (q, ...p) => {
        const rows = this.#mirror.prepare(q).all(...p) as SqlRow[];
        if (!/^\s*select\b/i.test(q)) journal.push({ q, p });
        return rows;
      },
    };
    this.#mirror.exec("SAVEPOINT tx");
    let result: T;
    try {
      result = fn(sql);
      if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("tx callback must be synchronous: an await would let other actions interleave");
      }
      this.#mirror.exec("RELEASE tx");
    } catch (e) {
      this.#mirror.exec("ROLLBACK TO tx");
      this.#mirror.exec("RELEASE tx");
      throw e;
    }
    if (journal.length > 0) await this.#flush(journal);
    return result;
  }

  /** Replay the changing statements in one `c.db` transaction, in order. */
  #flush(journal: Statement[]): Promise<void> {
    const run = async () => {
      if (this.#broken) throw this.#broken;
      try {
        await this.#c.db.transaction(
          async (t) => {
            if (this.#epoch !== undefined) {
              const stored = Number((await t.execute("SELECT v FROM host_meta WHERE k = 'owner_epoch'"))[0]?.["v"]);
              if (stored !== this.#epoch) throw new FencedError(this.#epoch, stored);
            }
            for (const j of journal) await t.execute(j.q, ...j.p);
          },
          { name: "host.tx" },
        );
      } catch (e) {
        this.#broken = e;
        throw e;
      }
    };
    const p = this.#chain.then(run);
    this.#chain = p.catch(() => undefined);
    return p;
  }

  /** Resolves when every earlier `tx` is durable. */
  async commit(): Promise<void> {
    await this.#chain;
    if (this.#broken) throw this.#broken;
  }

  /**
   * Schedule the platform timer first, then write the `wake_timers` row. If
   * the schedule fails, nothing is written. If the write fails, a timer with no
   * row stays, and it does nothing when it fires. Resolves when the row is
   * durable.
   */
  async arm(at: Date, key: string): Promise<void> {
    const fireMs = Math.max(at.getTime(), this.#now());
    this.#opts.onWrite?.("timer");
    const id = await this.#c.schedule.at(fireMs, this.#opts.wakeAction ?? "hostWake", key);
    this.#opts.onWrite?.("row");
    const old = await this.tx((sql) => {
      const prev = sql.exec("SELECT schedule_id FROM wake_timers WHERE key = ?", key)[0]?.["schedule_id"];
      sql.exec(
        "INSERT INTO wake_timers (key, due_ms, fire_ms, schedule_id) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET due_ms = excluded.due_ms, fire_ms = excluded.fire_ms, " +
          "schedule_id = excluded.schedule_id",
        key,
        at.getTime(),
        fireMs,
        id,
      );
      return prev;
    });
    if (typeof old === "string") await this.#cancel(old);
  }

  async #cancel(id: string): Promise<void> {
    this.#opts.onWrite?.("timer");
    await this.#c.schedule.cancel(id);
  }

  /** Remove an obligation after its work is done. Not part of Host. */
  async disarm(key: string): Promise<void> {
    const old = await this.tx((sql) => {
      const prev = sql.exec("SELECT schedule_id FROM wake_timers WHERE key = ?", key)[0]?.["schedule_id"];
      sql.exec("DELETE FROM wake_timers WHERE key = ?", key);
      return prev;
    });
    if (old !== undefined) this.#opts.onWrite?.("row");
    if (typeof old === "string") await this.#cancel(old);
  }

  /** The runtime sets the function that runs when an obligation is due. */
  onWake(handler: WakeHandler): void {
    this.#handler = handler;
  }

  /**
   * Call this from the `hostWake` action. Rivet does not retry a failed
   * one-shot, so the first durable action is a new timer for the same row: at
   * its due time if it is still in the future (an early fire), or one retry
   * delay later if it is due. Only then does the handler run. A row stays until
   * `disarm(key)`. A missing row means a stale timer, and it is ignored.
   * Returns the keys that were due.
   */
  async handleWake(key: string): Promise<string[]> {
    const now = this.#now();
    const row = await this.tx((sql) => sql.exec("SELECT due_ms, schedule_id FROM wake_timers WHERE key = ?", key)[0]);
    if (!row) return [];
    const due = Number(row["due_ms"]) <= now;
    const fireMs = due ? now + (this.#opts.retryDelayMs ?? 60_000) : Number(row["due_ms"]);
    this.#opts.onWrite?.("timer");
    const id = await this.#c.schedule.at(fireMs, this.#opts.wakeAction ?? "hostWake", key);
    const stale = await this.tx((sql) => {
      const cur = sql.exec("SELECT schedule_id FROM wake_timers WHERE key = ?", key)[0];
      if (cur) this.#opts.onWrite?.("row");
      if (cur) sql.exec("UPDATE wake_timers SET fire_ms = ?, schedule_id = ? WHERE key = ?", fireMs, id, key);
      return cur ? cur["schedule_id"] : id;
    });
    if (typeof stale === "string") await this.#cancel(stale);
    if (!due) return [];
    if (this.#handler) await this.#handler([key]);
    return [key];
  }

  /**
   * Start a background task, such as the turn loop, inside `c.keepAwake`. The
   * actor does not sleep while the task runs. One task per name: a second call
   * returns the running one. Not part of Host.
   */
  startTask(name: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const running = this.#tasks.get(name);
    if (running) return running;
    const task = this.#c.keepAwake(
      run(this.#c.abortSignal)
        .catch((e) => this.#opts.onTaskError?.(name, e))
        .finally(() => this.#tasks.delete(name)),
    );
    this.#tasks.set(name, task);
    return task;
  }

  /** Keep the actor awake until `work` settles (`c.keepAwake`). The runtime's background work goes here. */
  keepAwake<T>(work: Promise<T>): Promise<T> {
    return this.#c.keepAwake(work);
  }

  /** Outbound HTTP. The signal aborts the request. */
  async fetch(req: Request, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    const doFetch = this.#opts.fetch ?? ((r: Request) => globalThis.fetch(r));
    return doFetch(signal ? new Request(req, { signal: AbortSignal.any([signal, req.signal]) }) : req);
  }

  /**
   * A client for a sidecar. It sends `POST <base>/rpc` with a JSON body
   * `{ method, params }` and the header `x-hermesd-epoch`. The sidecar answers
   * with the JSON result. A status that is not 2xx throws `SidecarError`.
   */
  sidecar(name: string): RpcClient {
    return {
      call: async <T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
        const target = this.#opts.sidecars?.[name];
        if (!target) throw new Error(`no sidecar named ${name}`);
        const req = new Request(`${typeof target === "string" ? target.replace(/\/$/, "") : "http://sidecar"}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hermesd-epoch": String(this.epoch()) },
          body: JSON.stringify({ method, params }),
          ...(signal ? { signal } : {}),
        });
        const res = typeof target === "string" ? await this.fetch(req, signal) : await target.fetch(req);
        if (!res.ok) throw new SidecarError(name, method, res.status, await res.text());
        return (await res.json()) as T;
      },
    };
  }
}

/**
 * rivetkit 3.0.7's native `c.db.execute` returns a BLOB column as a plain array of byte
 * numbers (found on the FTS5 `_data.block` column), which `node:sqlite` cannot bind.
 * A value that comes back as an array is a BLOB: turn it into bytes.
 */
function blobOf(v: unknown): unknown {
  return Array.isArray(v) ? Uint8Array.from(v as number[]) : v;
}

/**
 * `PRAGMA table_list` of a scratch database that holds only the virtual tables, for a source SQLite
 * without it. A virtual table that needs an ordinary table (FTS4 `content=` with no columns) gets it
 * first: the error names it.
 */
function shadowsInScratch(objects: Record<string, unknown>[], isVirtual: (o: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  const scratch = new DatabaseSync(":memory:");
  try {
    const byName = new Map(objects.filter((o) => o["type"] === "table").map((o) => [String(o["name"]), o] as const));
    for (const v of objects.filter((o) => o["type"] === "table" && isVirtual(o))) {
      for (let tries = 0; ; tries++) {
        try {
          scratch.exec(String(v["sql"]));
          break;
        } catch (e) {
          const missing = /no such table: (?:main\.)?"?([^"\s]+)"?/.exec(e instanceof Error ? e.message : "")?.[1];
          const dep = missing !== undefined ? byName.get(missing) : undefined;
          if (!dep || isVirtual(dep) || tries > objects.length) throw e;
          scratch.exec(String(dep["sql"]));
        }
      }
    }
    return scratch.prepare("PRAGMA table_list").all() as Record<string, unknown>[];
  } finally {
    scratch.close();
  }
}
