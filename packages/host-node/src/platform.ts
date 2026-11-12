import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Host, RpcClient, Sql, SqlRow, SqlValue } from "@hermesd/host";
import { VirtualClock } from "./clock.ts";
import { ArmFailedError, CrashError, StaleEpochError } from "./errors.ts";
import { FaultHooks, type EventKind, type FaultPoint, type PointRule } from "./faults.ts";

/**
 * The in-memory Node platform (porting guide rev 5.1, section 4.6, "a fourth
 * adapter").
 *
 * One `NodePlatform` hosts many actors by key. It is a simulator. It copies
 * the rules of a real platform so that tests run fast:
 *
 * - One writer per key. One live activation per key.
 * - Each actor has its own SQLite database (`node:sqlite`). A crash drops all
 *   JS state and all running promises. Committed rows stay. Rows that were
 *   not committed roll back.
 * - `owner_epoch` is kept in the actor's SQLite. The first committed
 *   transaction of each activation raises it.
 * - One alarm per actor (Durable Objects mode). Rivet mode keeps one timer
 *   per key.
 * - A virtual clock. Time moves only when a test calls `clock.advance`.
 *
 * Two modes choose the rules for interleaving:
 *
 * - `durable-objects`: an input gate and an output gate. No new event starts
 *   while a storage call runs. Nothing leaves the actor (reply, `fetch`,
 *   sidecar call) before the writes are durable. An awaited `fetch` lets
 *   another event run. A failed alarm is retried.
 * - `rivet`: an action can interleave at every await. There is no gate. Each
 *   `tx` is durable when it returns. A failed timer run is not retried.
 */
export type PlatformMode = "durable-objects" | "rivet";

/** What the platform calls on the actor code. All parts except `call` are optional. */
export interface ActorBehavior {
  /** Runs once per activation, after the epoch was raised. New events wait for it. */
  activate?(): Promise<void>;
  /** The alarm fired. It carries no data. The actor scans its own rows. */
  alarm?(): Promise<void>;
  /** A cron schedule fired. */
  cron?(name: string): Promise<void>;
  /** A request from a client or from another actor. */
  call(method: string, params: unknown): Promise<unknown>;
}

export type ActorFactory = (host: Host) => ActorBehavior;

export type SidecarHandler = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;

export interface PlatformOptions {
  mode?: PlatformMode;
  clock?: VirtualClock;
  /** Put the SQLite files in this directory. Default: in-memory databases. */
  dir?: string;
  /** Retry an alarm whose handler failed. Default: true on Durable Objects, false on Rivet. */
  retryFailedAlarms?: boolean;
  /** Keep one timer per arm key. Default: false on Durable Objects, true on Rivet. */
  multiAlarm?: boolean;
  /** Handles `Host.fetch`. Default: answers 200 "ok". */
  fetch?: (req: Request, signal?: AbortSignal) => Promise<Response>;
}

/** A handle on one activation. Used to talk to an old activation after `splitBrain`. */
export interface ActivationHandle {
  readonly epoch: number;
  call(method: string, params?: unknown): Promise<unknown>;
}

interface AlarmEntry {
  id: string;
  key: string;
  at: number;
  token: number;
}

interface Activation {
  alive: boolean;
  epoch: number;
  inflight: number;
  waiters: Array<() => void>;
  releasing: boolean;
  kill: (e: Error) => void;
  dead: Promise<never>;
  ready: Promise<void>;
  host: Host;
  behavior: ActorBehavior | undefined;
}

interface CronEntry {
  name: string;
  everyMs: number;
  cancel: () => void;
}

interface ActorRecord {
  key: string;
  factory: ActorFactory;
  storage: Storage;
  acts: Activation[];
  primary: Activation | undefined;
  alarms: Map<string, AlarmEntry>;
  cancel: Map<string, () => void>;
  attempts: Map<number, number>;
  crons: CronEntry[];
}

interface EventInfo {
  actor: string;
  kind: EventKind;
  method?: string;
}

const MAX_ALARM_RETRIES = 6;
const ALARM_BACKOFF_MS = 2000;

/** The SQLite database of one actor. Writes batch up in one outer transaction until flushed. */
class Storage {
  readonly db: DatabaseSync;
  #open = false;
  #cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS host_state (id INTEGER PRIMARY KEY CHECK (id = 1), owner_epoch INTEGER NOT NULL)");
    this.db.exec("INSERT OR IGNORE INTO host_state (id, owner_epoch) VALUES (1, 0)");
  }

  begin(): void {
    if (!this.#open) {
      this.db.exec("BEGIN");
      this.#open = true;
    }
  }

  /** Make every buffered write durable. */
  flush(): void {
    if (this.#open) {
      this.db.exec("COMMIT");
      this.#open = false;
    }
  }

  /** Drop every write that is not durable yet. */
  rollback(): void {
    if (this.#open) {
      this.db.exec("ROLLBACK");
      this.#open = false;
    }
  }

  readEpoch(): number {
    const row = this.db.prepare("SELECT owner_epoch AS e FROM host_state WHERE id = 1").get() as { e: number } | undefined;
    return Number(row?.e ?? 0);
  }

  exec(query: string, params: SqlValue[]): SqlRow[] {
    if (params.length === 0 && /;\s*\S/.test(query)) {
      this.db.exec(query);
      return [];
    }
    let stmt = this.#cache.get(query);
    if (!stmt) {
      stmt = this.db.prepare(query);
      this.#cache.set(query, stmt);
    }
    const rows = stmt.all(...(params as never[])) as Array<Record<string, SqlValue>>;
    return rows.map((r) => ({ ...r }));
  }

  close(): void {
    this.rollback();
    this.db.close();
  }
}

function forever<T = never>(): Promise<T> {
  return new Promise<T>(() => {});
}

export class NodePlatform {
  readonly clock: VirtualClock;
  readonly mode: PlatformMode;
  readonly #dir: string | undefined;
  readonly #retry: boolean;
  readonly #multi: boolean;
  readonly #fetchImpl: (req: Request, signal?: AbortSignal) => Promise<Response>;
  readonly #faults = new FaultHooks();
  readonly #als = new AsyncLocalStorage<EventInfo>();
  readonly #actors = new Map<string, ActorRecord>();
  readonly #sidecars = new Map<string, SidecarHandler>();
  #busy = 0;
  #tokens = 0;

  constructor(options: PlatformOptions = {}) {
    this.mode = options.mode ?? "durable-objects";
    this.clock = options.clock ?? new VirtualClock();
    this.#dir = options.dir;
    this.#retry = options.retryFailedAlarms ?? this.mode === "durable-objects";
    this.#multi = options.multiAlarm ?? this.mode === "rivet";
    this.#fetchImpl = options.fetch ?? (async () => new Response("ok"));
    this.clock.setSettle(() => this.idle());
  }

  get #doMode(): boolean {
    return this.mode === "durable-objects";
  }

  // ---------------------------------------------------------------- setup

  /** Register an actor by key. The factory is the actor's code. It survives crashes. */
  defineActor(key: string, factory: ActorFactory): void {
    if (this.#actors.has(key)) throw new Error(`actor ${key} already defined`);
    const path = this.#dir ? join(this.#dir, `${encodeURIComponent(key)}.sqlite`) : ":memory:";
    this.#actors.set(key, {
      key,
      factory,
      storage: new Storage(path),
      acts: [],
      primary: undefined,
      alarms: new Map(),
      cancel: new Map(),
      attempts: new Map(),
      crons: [],
    });
  }

  /** Register a named sidecar, such as "executor". Actors reach actors as "actor:<key>". */
  registerSidecar(name: string, handler: SidecarHandler): void {
    this.#sidecars.set(name, handler);
  }

  /** Run `name` on the actor every `everyMs` of virtual time. The schedule is durable. */
  cron(key: string, name: string, everyMs: number): void {
    const rec = this.#rec(key);
    const entry: CronEntry = { name, everyMs, cancel: () => {} };
    rec.crons.push(entry);
    const arm = (at: number): void => {
      entry.cancel = this.clock.schedule(at, async () => {
        arm(at + everyMs);
        await this.#deliverCron(rec, name);
      });
    };
    arm(this.clock.now() + everyMs);
  }

  // ---------------------------------------------------------------- clients

  /** Send a request to an actor. Wakes the actor if it is not running. */
  async call(key: string, method: string, params?: unknown): Promise<unknown> {
    const rec = this.#rec(key);
    const act = await this.#ensureActive(rec);
    return this.#run(rec, act, { actor: key, kind: "call", method }, () => this.#behavior(act).call(method, params));
  }

  /** Is the actor running now? */
  isActive(key: string): boolean {
    return this.#rec(key).primary?.alive === true;
  }

  /** The owner epoch that the actor's SQLite holds. */
  epochOf(key: string): number {
    return this.#rec(key).storage.readEpoch();
  }

  /** Read rows from the actor's SQLite. For test assertions. */
  query(key: string, query: string, ...params: SqlValue[]): SqlRow[] {
    return this.#rec(key).storage.exec(query, params);
  }

  /** Wait until no event or storage call is in flight. */
  async idle(): Promise<void> {
    let quiet = 0;
    while (quiet < 3) {
      await new Promise<void>((r) => setImmediate(r));
      quiet = this.#busy === 0 ? quiet + 1 : 0;
    }
  }

  /** Close all databases. */
  close(): void {
    for (const rec of this.#actors.values()) {
      for (const c of rec.cancel.values()) c();
      for (const c of rec.crons) c.cancel();
      rec.storage.close();
    }
    this.#actors.clear();
  }

  // ---------------------------------------------------------------- fault hooks

  /** Crash the actor when it reaches the point. */
  crashAt(rule: PointRule): void {
    this.#faults.crashAt(rule);
  }

  /** Run a hook at the point. The hook may start other work, such as a timer fire. */
  onPoint(rule: PointRule, hook: () => void | Promise<void>): void {
    this.#faults.onPoint(rule, hook);
  }

  /** Make the next `times` arm calls of this actor fail. */
  failArm(key: string, times = 1): void {
    this.#faults.failArm(key, times);
  }

  /** Delete the actor's timer. Nothing fires. */
  deleteTimer(key: string): void {
    const rec = this.#rec(key);
    for (const c of rec.cancel.values()) c();
    rec.cancel.clear();
    rec.alarms.clear();
  }

  /**
   * Deliver the alarm now, also if the time has not come, and also if no timer
   * is set. The timer stays if it is not due. Returns when the handler ended.
   */
  fireTimerEarly(key: string): Promise<void> {
    const rec = this.#rec(key);
    const first = [...rec.alarms.values()].sort((a, b) => a.at - b.at)[0];
    return this.#deliverAlarm(rec, first);
  }

  /** The earliest timer of the actor, or null. */
  alarmOf(key: string): { at: number; key: string } | null {
    const first = [...this.#rec(key).alarms.values()].sort((a, b) => a.at - b.at)[0];
    return first ? { at: first.at, key: first.key } : null;
  }

  /** Crash the actor now. JS state and running promises are gone. Uncommitted rows roll back. */
  crash(key: string): void {
    const rec = this.#rec(key);
    for (const act of rec.acts) {
      act.alive = false;
      act.waiters = [];
      act.kill(new CrashError(key));
    }
    rec.acts = [];
    rec.primary = undefined;
    rec.storage.rollback();
  }

  /**
   * Break the single-writer rule on purpose. A second activation starts and
   * raises the epoch. The old one keeps running. Its writes must fail with a
   * stale epoch. Returns a handle for each.
   */
  async splitBrain(key: string): Promise<{ old: ActivationHandle; fresh: ActivationHandle }> {
    const rec = this.#rec(key);
    const oldAct = await this.#ensureActive(rec);
    const freshAct = this.#startActivation(rec);
    await freshAct.ready;
    const handle = (act: Activation): ActivationHandle => ({
      get epoch() {
        return act.epoch;
      },
      call: (method, params) =>
        this.#run(rec, act, { actor: key, kind: "call", method }, () => this.#behavior(act).call(method, params)),
    });
    return { old: handle(oldAct), fresh: handle(freshAct) };
  }

  // ---------------------------------------------------------------- internals

  #rec(key: string): ActorRecord {
    const rec = this.#actors.get(key);
    if (!rec) throw new Error(`unknown actor ${key}`);
    return rec;
  }

  #behavior(act: Activation): ActorBehavior {
    if (!act.behavior) throw new Error("actor not ready");
    return act.behavior;
  }

  async #hop(): Promise<void> {
    this.#busy++;
    try {
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      this.#busy--;
    }
  }

  async #ensureActive(rec: ActorRecord): Promise<Activation> {
    let act = rec.primary;
    if (!act || !act.alive) act = this.#startActivation(rec);
    await act.ready;
    return act;
  }

  #startActivation(rec: ActorRecord): Activation {
    let kill!: (e: Error) => void;
    const dead = new Promise<never>((_, rej) => {
      kill = rej;
    });
    dead.catch(() => {});
    const act: Activation = {
      alive: true,
      epoch: 0,
      inflight: 0,
      waiters: [],
      releasing: false,
      kill,
      dead,
      ready: Promise.resolve(),
      host: undefined as unknown as Host,
      behavior: undefined,
    };
    act.host = this.#makeHost(rec, act);
    rec.acts.push(act);
    rec.primary = act;
    const work = this.#als.run({ actor: rec.key, kind: "activate" }, async () => {
      // The first committed transaction of the activation raises the epoch.
      rec.storage.begin();
      rec.storage.db.exec("UPDATE host_state SET owner_epoch = owner_epoch + 1 WHERE id = 1");
      act.epoch = rec.storage.readEpoch();
      rec.storage.flush();
      await this.#hop();
      if (!act.alive) return forever<void>();
      act.behavior = rec.factory(act.host);
      await act.behavior.activate?.();
    });
    work.catch(() => {
      // An activation that fails is dropped, so the next event starts a new one.
      if (act.alive) {
        act.alive = false;
        if (rec.primary === act) rec.primary = undefined;
        rec.acts = rec.acts.filter((a) => a !== act);
      }
    });
    act.ready = Promise.race([work, act.dead]);
    act.ready.catch(() => {});
    return act;
  }

  /** Wait for the input gate (Durable Objects only). */
  async #gate(act: Activation): Promise<void> {
    if (!this.#doMode || (act.inflight === 0 && act.waiters.length === 0)) return;
    await new Promise<void>((res) => act.waiters.push(res));
  }

  #scheduleRelease(act: Activation): void {
    if (act.releasing || act.waiters.length === 0) return;
    act.releasing = true;
    setImmediate(() => {
      act.releasing = false;
      if (!act.alive) return;
      if (act.inflight === 0 && act.waiters.length > 0) {
        act.waiters.shift()!();
      }
      this.#scheduleRelease(act);
    });
  }

  /** Make buffered writes durable before something leaves the actor (output gate). */
  async #outputGate(rec: ActorRecord): Promise<void> {
    if (!this.#doMode) return;
    rec.storage.flush();
    await this.#hop();
  }

  /** Run one event on an activation. */
  async #run<T>(rec: ActorRecord, act: Activation, info: EventInfo, fn: () => Promise<T>): Promise<T> {
    this.#busy++;
    try {
      await act.ready;
      if (this.#doMode && (act.inflight > 0 || act.waiters.length > 0)) {
        const waiting = this.#gate(act);
        this.#scheduleRelease(act);
        await Promise.race([waiting, act.dead]);
      }
      if (!act.alive) throw new CrashError(rec.key);
      const work = this.#als.run(info, async (): Promise<T> => {
        const out = await fn();
        if (!act.alive) return forever<T>();
        await this.#outputGate(rec);
        if (info.kind === "call") await this.#point(rec, act, "reply:before");
        if (!act.alive) return forever<T>();
        return out;
      });
      work.catch(() => {});
      return await Promise.race([work, act.dead]);
    } finally {
      this.#busy--;
    }
  }

  /** Check a fault point. May crash the actor, or run a hook. */
  async #point(rec: ActorRecord, act: Activation, point: FaultPoint, detail?: string): Promise<void> {
    if (!act.alive) return;
    const info = this.#als.getStore();
    const actions = this.#faults.match(rec.key, point, { event: info?.kind, method: info?.method, detail });
    for (const action of actions) {
      if ("crash" in action) this.crash(rec.key);
      else await action.hook();
    }
  }

  #pointSync(rec: ActorRecord, point: FaultPoint): boolean {
    const info = this.#als.getStore();
    const actions = this.#faults.match(rec.key, point, { event: info?.kind, method: info?.method, detail: undefined });
    if (actions.some((a) => "crash" in a)) {
      this.crash(rec.key);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- alarms

  #setAlarm(rec: ActorRecord, at: number, key: string): void {
    const id = this.#multi ? key : "$";
    if (this.#multi) {
      rec.cancel.get(id)?.();
    } else {
      for (const c of rec.cancel.values()) c();
      rec.cancel.clear();
      rec.alarms.clear();
    }
    const entry: AlarmEntry = { id, key, at, token: ++this.#tokens };
    rec.alarms.set(id, entry);
    rec.cancel.set(
      id,
      this.clock.schedule(at, () => this.#fire(rec, entry)),
    );
  }

  /** Remove the timer of a key. With one alarm per actor, only when that alarm is for this key. */
  #disarm(rec: ActorRecord, key: string): void {
    const id = this.#multi ? key : "$";
    if (rec.alarms.get(id)?.key === key) this.#removeAlarm(rec, id);
  }

  #removeAlarm(rec: ActorRecord, id: string): void {
    rec.cancel.get(id)?.();
    rec.cancel.delete(id);
    rec.alarms.delete(id);
  }

  async #fire(rec: ActorRecord, entry: AlarmEntry): Promise<void> {
    const cur = rec.alarms.get(entry.id);
    if (!cur || cur.token !== entry.token) return;
    await this.#deliverAlarm(rec, cur);
  }

  async #deliverAlarm(rec: ActorRecord, entry: AlarmEntry | undefined): Promise<void> {
    let ok = true;
    try {
      const act = await this.#ensureActive(rec);
      await this.#run(rec, act, { actor: rec.key, kind: "alarm" }, async () => {
        await act.behavior?.alarm?.();
      });
    } catch {
      ok = false;
    }
    if (!entry) return;
    const cur = rec.alarms.get(entry.id);
    // The handler set a new alarm, or a test deleted it: leave it alone.
    if (!cur || cur.token !== entry.token) return;
    if (ok) {
      if (cur.at <= this.clock.now()) this.#removeAlarm(rec, entry.id);
      return;
    }
    const n = rec.attempts.get(entry.token) ?? 0;
    if (this.#retry && n < MAX_ALARM_RETRIES) {
      rec.attempts.set(entry.token, n + 1);
      rec.cancel.get(entry.id)?.();
      rec.cancel.set(
        entry.id,
        this.clock.schedule(this.clock.now() + ALARM_BACKOFF_MS * 2 ** n, () => this.#fire(rec, entry)),
      );
    } else {
      this.#removeAlarm(rec, entry.id);
    }
  }

  async #deliverCron(rec: ActorRecord, name: string): Promise<void> {
    try {
      const act = await this.#ensureActive(rec);
      await this.#run(rec, act, { actor: rec.key, kind: "cron", method: name }, async () => {
        await act.behavior?.cron?.(name);
      });
    } catch {
      // A failed cron run is not retried. The next tick comes on schedule.
    }
  }

  // ---------------------------------------------------------------- the Host

  #makeHost(rec: ActorRecord, act: Activation): Host {
    const platform = this;
    const st = rec.storage;
    return {
      id: () => rec.key,
      epoch: () => act.epoch,

      async tx<T>(fn: (sql: Sql) => T): Promise<T> {
        if (!act.alive) return forever<T>();
        // The storage call is in flight from the moment it starts. This closes the input gate.
        act.inflight++;
        try {
          await platform.#point(rec, act, "tx:before");
          if (!act.alive) return forever<T>();
          const stored = st.readEpoch();
          if (stored > act.epoch) throw new StaleEpochError(act.epoch, stored);
          st.begin();
          st.db.exec("SAVEPOINT hx");
          let live = true;
          const sql: Sql = {
            exec(query, ...params) {
              if (!live) throw new Error("the Sql handle was used after its transaction ended");
              return st.exec(query, params);
            },
          };
          let out: T;
          try {
            out = fn(sql);
            if (out instanceof Promise) throw new TypeError("tx function must be synchronous");
          } catch (e) {
            live = false;
            st.db.exec("ROLLBACK TO hx");
            st.db.exec("RELEASE hx");
            throw e;
          }
          live = false;
          if (platform.#pointSync(rec, "tx:before-commit")) return forever<T>();
          st.db.exec("RELEASE hx");
          if (!platform.#doMode) st.flush();
          await platform.#hop();
          if (!act.alive) return forever<T>();
          await platform.#point(rec, act, "tx:after");
          if (!act.alive) return forever<T>();
          return out;
        } finally {
          act.inflight--;
          platform.#scheduleRelease(act);
        }
      },

      async commit(): Promise<void> {
        if (!act.alive) return forever<void>();
        act.inflight++;
        try {
          await platform.#point(rec, act, "commit:before");
          if (!act.alive) return forever<void>();
          st.flush();
          await platform.#hop();
          if (!act.alive) return forever<void>();
          await platform.#point(rec, act, "commit:after");
          if (!act.alive) return forever<void>();
        } finally {
          act.inflight--;
          platform.#scheduleRelease(act);
        }
      },

      async arm(at: Date, key: string): Promise<void> {
        if (!act.alive) return forever<void>();
        act.inflight++;
        try {
          await platform.#point(rec, act, "arm:before");
          if (!act.alive) return forever<void>();
          if (platform.#faults.consumeArmFailure(rec.key)) throw new ArmFailedError(rec.key);
          platform.#setAlarm(rec, at.getTime(), key);
          // Durable Objects: setAlarm, then storage.sync(). The sync also flushes pending writes.
          if (platform.#doMode) st.flush();
          await platform.#hop();
          if (!act.alive) return forever<void>();
          await platform.#point(rec, act, "arm:after");
          if (!act.alive) return forever<void>();
        } finally {
          act.inflight--;
          platform.#scheduleRelease(act);
        }
      },

      async disarm(key: string): Promise<void> {
        if (!act.alive) return forever<void>();
        act.inflight++;
        try {
          await platform.#point(rec, act, "disarm:before");
          if (!act.alive) return forever<void>();
          platform.#disarm(rec, key);
        } finally {
          act.inflight--;
          platform.#scheduleRelease(act);
        }
      },

      async fetch(req: Request, signal?: AbortSignal): Promise<Response> {
        if (!act.alive) return forever<Response>();
        await platform.#point(rec, act, "fetch:before");
        if (!act.alive) return forever<Response>();
        signal?.throwIfAborted();
        await platform.#outputGate(rec);
        if (!act.alive) return forever<Response>();
        platform.#busy++;
        let res: Response;
        try {
          res = await platform.#fetchImpl(req, signal);
        } finally {
          platform.#busy--;
        }
        if (!act.alive) return forever<Response>();
        await platform.#point(rec, act, "fetch:after");
        if (!act.alive) return forever<Response>();
        return res;
      },

      sidecar(name: string): RpcClient {
        return {
          async call<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
            if (!act.alive) return forever<T>();
            await platform.#point(rec, act, "sidecar:before", `${name}.${method}`);
            if (!act.alive) return forever<T>();
            signal?.throwIfAborted();
            await platform.#outputGate(rec);
            if (!act.alive) return forever<T>();
            let out: unknown;
            platform.#busy++;
            try {
              const handler = platform.#sidecars.get(name);
              if (handler) out = await handler(method, params, signal);
              else if (name.startsWith("actor:")) out = await platform.call(name.slice("actor:".length), method, params);
              else throw new Error(`unknown sidecar ${name}`);
            } finally {
              platform.#busy--;
            }
            if (!act.alive) return forever<T>();
            await platform.#point(rec, act, "sidecar:after", `${name}.${method}`);
            if (!act.alive) return forever<T>();
            return out as T;
          },
        };
      },
    };
  }
}
