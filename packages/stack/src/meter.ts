import type { Host, OwnerEpoch, RpcClient, Sql } from "@hermesd/host";
import type { MeterSnapshot, StackFaultPoint, StackFaultRule } from "./types.ts";

/**
 * Counts what an actor does at the Host interface, and crashes it at a fault point.
 *
 * It wraps the adapter's Host, so the same counts come from every platform. It uses
 * no Node API, so it runs inside workerd and rivetkit as it is. The platform glue
 * calls `event()` around each call, alarm and cron it hands to the actor.
 */
export class Meter {
  #m: MeterSnapshot = Meter.empty();
  /** Open spans, all and without the model call. */
  #open = 0;
  #openExcl = 0;
  #since = 0;
  #sinceExcl = 0;
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  static empty(): MeterSnapshot {
    return {
      activations: 0,
      events: 0,
      tx: 0,
      statements: 0,
      rowsChanged: 0,
      commits: 0,
      arms: 0,
      disarms: 0,
      fetches: 0,
      sidecars: {},
      busyMs: 0,
      busyExclModelMs: 0,
    };
  }

  /** The live counters. The hosts add to them. */
  get counts(): MeterSnapshot {
    return this.#m;
  }

  snapshot(): MeterSnapshot {
    const now = this.#now();
    const m = { ...this.#m, sidecars: { ...this.#m.sidecars } };
    if (this.#open > 0) m.busyMs += now - this.#since;
    if (this.#openExcl > 0) m.busyExclModelMs += now - this.#sinceExcl;
    return m;
  }

  reset(): void {
    const now = this.#now();
    this.#m = Meter.empty();
    this.#since = now;
    this.#sinceExcl = now;
  }

  /** Count a span of wall time in `busyMs`. A `model` span is left out of `busyExclModelMs`. */
  async span<T>(fn: () => Promise<T>, model = false): Promise<T> {
    const start = this.#now();
    if (this.#open++ === 0) this.#since = start;
    if (!model && this.#openExcl++ === 0) this.#sinceExcl = start;
    try {
      return await fn();
    } finally {
      const end = this.#now();
      if (--this.#open === 0) this.#m.busyMs += end - this.#since;
      if (!model && --this.#openExcl === 0) this.#m.busyExclModelMs += end - this.#sinceExcl;
    }
  }

  /** The platform glue wraps each event it gives the actor. */
  event<T>(fn: () => Promise<T>): Promise<T> {
    this.#m.events += 1;
    return this.span(fn);
  }
}

/** Crash rules that a test installed, shared by the actors of one isolate. */
export class FaultRules {
  #rules: Array<{ rule: StackFaultRule; seen: number; done: boolean }> = [];

  add(rule: StackFaultRule): void {
    this.#rules.push({ rule, seen: 0, done: false });
  }

  clear(): void {
    this.#rules = [];
  }

  /** True when a rule for this actor and point acts now. */
  hit(actor: string, point: StackFaultPoint, detail?: string): boolean {
    for (const r of this.#rules) {
      if (r.done || r.rule.actor !== actor || r.rule.point !== point) continue;
      if (r.rule.detail !== undefined && r.rule.detail !== detail) continue;
      r.seen += 1;
      if (r.seen >= (r.rule.nth ?? 1)) {
        r.done = true;
        return true;
      }
    }
    return false;
  }
}

export interface MeteredHostOptions {
  actor: string;
  meter: Meter;
  rules?: FaultRules;
  /**
   * Throw the actor out of memory, the platform's way (`ctx.abort()` on Durable
   * Objects). It must not return normally; if it does, the host throws.
   */
  crash?: () => never | void;
}

export class CrashedError extends Error {
  constructor(point: string) {
    super(`crashed at ${point}`);
    this.name = "CrashedError";
  }
}

/** A Host that counts every call and can crash at a fault point. */
export class MeteredHost implements Host {
  readonly inner: Host;
  readonly #o: MeteredHostOptions;
  readonly disarm?: (key: string) => Promise<void>;
  readonly keepAwake?: <T>(work: Promise<T>) => Promise<T>;
  #changes: "unknown" | "yes" | "no" = "unknown";

  constructor(inner: Host, opts: MeteredHostOptions) {
    this.inner = inner;
    this.#o = opts;
    opts.meter.counts.activations += 1;
    if (inner.keepAwake) this.keepAwake = (w) => inner.keepAwake!(w);
    if (inner.disarm) {
      this.disarm = async (key) => {
        this.#o.meter.counts.disarms += 1;
        await this.#o.meter.span(() => inner.disarm!(key));
      };
    }
  }

  #point(point: StackFaultPoint, detail?: string): void {
    if (this.#o.rules?.hit(this.#o.actor, point, detail)) {
      this.#o.crash?.();
      throw new CrashedError(point);
    }
  }

  id(): string {
    return this.inner.id();
  }

  epoch(): OwnerEpoch {
    return this.inner.epoch();
  }

  async tx<T>(fn: (sql: Sql) => T): Promise<T> {
    const m = this.#o.meter.counts;
    this.#point("tx:before");
    m.tx += 1;
    const r = await this.inner.tx((sql) => {
      const counted: Sql = {
        exec: (q, ...p) => {
          m.statements += 1;
          return sql.exec(q, ...p);
        },
      };
      const before = this.#total(sql);
      const out = fn(counted);
      const after = this.#total(sql);
      if (before >= 0 && after >= 0 && m.rowsChanged >= 0) m.rowsChanged += after - before;
      else m.rowsChanged = -1;
      return out;
    });
    this.#point("tx:after");
    return r;
  }

  #total(sql: Sql): number {
    if (this.#changes === "no") return -1;
    try {
      const n = Number(sql.exec("SELECT total_changes() AS n")[0]?.["n"]);
      this.#changes = Number.isFinite(n) ? "yes" : "no";
      return Number.isFinite(n) ? n : -1;
    } catch {
      this.#changes = "no";
      return -1;
    }
  }

  async commit(): Promise<void> {
    this.#point("commit:before");
    this.#o.meter.counts.commits += 1;
    await this.#o.meter.span(() => this.inner.commit());
    this.#point("commit:after");
  }

  async arm(at: Date, key: string): Promise<void> {
    this.#point("arm:before");
    this.#o.meter.counts.arms += 1;
    await this.#o.meter.span(() => this.inner.arm(at, key));
    this.#point("arm:after");
  }

  async fetch(req: Request, signal?: AbortSignal): Promise<Response> {
    this.#point("fetch:before");
    this.#o.meter.counts.fetches += 1;
    const res = await this.#o.meter.span(() => this.inner.fetch(req, signal), true);
    this.#point("fetch:after");
    return res;
  }

  sidecar(name: string): RpcClient {
    const inner = this.inner.sidecar(name);
    return {
      call: async <T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
        const detail = `${name}.${method}`;
        this.#point("sidecar:before", detail);
        const s = this.#o.meter.counts.sidecars;
        s[detail] = (s[detail] ?? 0) + 1;
        const r = await this.#o.meter.span(() => inner.call<T>(method, params, signal));
        this.#point("sidecar:after", detail);
        return r;
      },
    };
  }
}
