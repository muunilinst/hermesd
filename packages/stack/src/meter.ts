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
  /**
   * Open spans: all of them, and the model-wait ones among them (a model span is also in
   * `#open`). Time is accrued at every change and at every snapshot, as intervals:
   * `busyMs` is the union of all spans, `busyExclModelMs` is that union minus the union of
   * the model spans, so a model wait nested inside an event is subtracted from the event.
   */
  #open = 0;
  #openModel = 0;
  #last = 0;
  /** Bumped by `abandon`; a span that began in an earlier generation does not touch the counts. */
  #gen = 0;
  /** True from an activation until its first event; `#m.firstEvents` takes that event's label. */
  #fresh = false;
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  static empty(): MeterSnapshot {
    return {
      activations: 0,
      firstEvents: [],
      events: 0,
      tx: 0,
      statements: 0,
      rowsChanged: 0,
      commits: 0,
      arms: 0,
      disarms: 0,
      fetches: 0,
      sidecars: {},
      adapterRows: 0,
      timerCalls: 0,
      busyMs: 0,
      busyExclModelMs: 0,
    };
  }

  /** The live counters. The hosts add to them. */
  get counts(): MeterSnapshot {
    return this.#m;
  }

  /** A new activation of the actor began: its first event is recorded. */
  activated(): void {
    this.#m.activations += 1;
    this.#fresh = true;
  }

  /** The adapters report their own writes here (`onWrite` of CloudflareHost and RivetHost). */
  adapterWrite(kind: "row" | "timer", n = 1): void {
    if (kind === "row") this.#m.adapterRows += n;
    else this.#m.timerCalls += n;
  }

  #accrue(): void {
    const now = this.#now();
    const dt = now - this.#last;
    this.#last = now;
    if (this.#open > 0) {
      this.#m.busyMs += dt;
      if (this.#openModel === 0) this.#m.busyExclModelMs += dt;
    }
  }

  snapshot(): MeterSnapshot {
    this.#accrue();
    return { ...this.#m, sidecars: { ...this.#m.sidecars }, firstEvents: [...this.#m.firstEvents] };
  }

  reset(): void {
    this.#m = Meter.empty();
    this.#last = this.#now();
  }

  /**
   * End every open span now: the activation that opened them died (a crash or an eviction), and
   * the promises they wrap may never settle. The spans stop accruing time here; when a wrapped
   * promise does settle later, it leaves the counts alone, so the activation that replaces the
   * dead one (which shares this meter) is not disturbed.
   */
  abandon(): void {
    this.#accrue();
    this.#open = 0;
    this.#openModel = 0;
    this.#gen++;
  }

  /** Count a span of wall time in `busyMs`. A `model` span is left out of `busyExclModelMs`. */
  async span<T>(fn: () => Promise<T>, model = false): Promise<T> {
    this.#accrue();
    const gen = this.#gen;
    this.#open++;
    if (model) this.#openModel++;
    try {
      return await fn();
    } finally {
      if (gen === this.#gen) {
        this.#accrue();
        this.#open--;
        if (model) this.#openModel--;
      }
    }
  }

  /** The platform glue wraps each event it gives the actor. */
  event<T>(fn: () => Promise<T>, label = "event"): Promise<T> {
    this.#m.events += 1;
    if (this.#fresh) {
      this.#fresh = false;
      this.#m.firstEvents.push(label);
    }
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
    // Every matching rule counts the event, as in host-node's FaultHooks.match: do not return early.
    let fire = false;
    for (const r of this.#rules) {
      if (r.done || r.rule.actor !== actor || r.rule.point !== point) continue;
      if (r.rule.detail !== undefined && r.rule.detail !== detail) continue;
      r.seen += 1;
      if (r.seen >= (r.rule.nth ?? 1)) {
        r.done = true;
        fire = true;
      }
    }
    return fire;
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
    opts.meter.activated();
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
      this.#o.meter.abandon();
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
    // The span covers the call to the adapter: Rivet awaits its native database there.
    const r = await this.#o.meter.span(() => this.inner.tx((sql) => {
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
    }));
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
