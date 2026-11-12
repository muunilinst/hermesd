import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { CloudflareHost, type FetcherLike } from "@hermesd/host-cloudflare";
import type { ActorBehavior } from "@hermesd/runtime";
import { FaultRules, Meter, MeteredHost } from "./meter.ts";
import { assertReadOnlySql } from "./readonly-sql.ts";
import type { ActorName, StackFaultRule, StackOptions } from "./types.ts";
import { ExecutorService, GatewayService, ModelService, NAMES, actorFactory, meteredBehavior } from "./world.ts";

/**
 * The milestone 1 world as Durable Objects with SQLite storage, for workerd. Bundled
 * by `workerd.ts` and run in Miniflare. Options arrive in the `OPTS` binding (JSON).
 *
 *  - `Session` (s1), `Sweeper`, `Profile`: one actor each, on a MeteredHost around a
 *    CloudflareHost. The behavior is built per instance, so an eviction (`ctx.abort()`)
 *    gives the next request a new instance and a higher owner epoch.
 *  - `Services`: model, executor and gateway in one object, so they outlive an actor restart.
 *  - Meters and crash rules are module globals: they outlive an instance, and every
 *    object of the worker shares the isolate.
 */
interface Ns {
  idFromName(name: string): unknown;
  get(id: unknown): FetcherLike;
}
interface Env {
  OPTS: string;
  SESSION: Ns;
  SWEEPER: Ns;
  PROFILE: Ns;
  SERVICES: Ns;
}

const meters = new Map<ActorName, Meter>();
const rules = new FaultRules();
let crashesFired = 0;
const meterOf = (a: ActorName): Meter => {
  let m = meters.get(a);
  if (!m) meters.set(a, (m = new Meter()));
  return m;
};
const clock = { now: () => Date.now() };
const json = (v: unknown, status = 200) => Response.json(v ?? null, { status });
const optsOf = (env: Env): StackOptions => JSON.parse(env.OPTS) as StackOptions;
const fail = (e: unknown) => json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, 500);

/** A SQLite BLOB crosses JSON as {"$blob": base64}; workerd.ts decodes it. */
const encodeValue = (v: unknown): unknown => {
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return { $blob: btoa(bin) };
  }
  return v;
};

const BINDING = { s1: "SESSION", sweeper: "SWEEPER", profile: "PROFILE" } as const;
const actorStub = (env: Env, a: ActorName): FetcherLike => env[BINDING[a]].get(env[BINDING[a]].idFromName(a));
const servicesStub = (env: Env): FetcherLike => env.SERVICES.get(env.SERVICES.idFromName("services"));
const viaServices = (env: Env, path: string): FetcherLike => ({
  fetch: (req) => servicesStub(env).fetch(new Request(`http://services${path}`, req)),
});

/**
 * The model request crosses a Durable Object boundary, and workerd does not carry an abort signal across it.
 * So cancellation is relayed: when the request's signal fires, a second request names the call (its
 * idempotency key) and `Services` aborts the model call that is waiting for it. The caller's promise
 * rejects at once, as an aborted fetch does on the other hosts.
 */
const modelVia = (env: Env): FetcherLike => ({
  fetch: (req) => {
    const signal = req.signal;
    signal.throwIfAborted();
    const callId = req.headers.get("idempotency-key");
    const call = servicesStub(env).fetch(new Request("http://services/model", req));
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        if (callId !== null) {
          void servicesStub(env)
            .fetch(new Request("http://services/model/cancel", { method: "POST", body: JSON.stringify({ callId }) }))
            .catch(() => undefined);
        }
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      call.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  },
});

class ActorDO extends DurableObject<Env> {
  readonly #host: CloudflareHost;
  readonly #behavior: ActorBehavior;
  readonly #meter: Meter;
  readonly #token: number;
  #active: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env, name: ActorName) {
    super(ctx, env);
    const sidecars: Record<string, FetcherLike> = {
      [NAMES.executor]: viaServices(env, "/executor/rpc"),
      [NAMES.gateway]: viaServices(env, "/gateway/rpc"),
      [NAMES.sweeper]: actorStub(env, "sweeper"),
      [NAMES.profile]: actorStub(env, "profile"),
      [NAMES.actorTarget(NAMES.session)]: actorStub(env, "s1"),
    };
    const meter = meterOf(name);
    this.#meter = meter;
    this.#host = new CloudflareHost(ctx, {
      sidecars,
      fetch: (req) => modelVia(env).fetch(req),
      onWrite: (kind) => meter.adapterWrite(kind),
    });
    const host = new MeteredHost(this.#host, { actor: name, meter, rules, crash: () => {
      crashesFired += 1;
      ctx.abort("injected crash");
    } });
    this.#token = host.token;
    // Alarms are metered once at `alarm()`, before the adapter decides whether any work is due.
    this.#behavior = meteredBehavior(actorFactory(name, optsOf(env), clock)(host), meter, { token: host.token, alarms: false });
    this.#host.onAlarm(async () => void (await this.#behavior.alarm?.()));
  }

  /** `activate()` runs once per instance, after the epoch is durable, before the first event. */
  #ready(): Promise<void> {
    this.#active ??= this.#host.ready.then(() => this.#behavior.activate?.());
    return this.#active;
  }

  async alarm(): Promise<void> {
    await this.#ready();
    // An alarm with nothing due still activated the actor: it counts as the activation's first event.
    await this.#meter.event(() => this.#host.handleAlarm(), "alarm", this.#token);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      await this.#ready();
      if (path === "/rpc") {
        const { method, params } = (await req.json()) as { method: string; params: unknown };
        return json(await this.#behavior.call(method, params));
      }
      if (path === "/ctl/cron") return json(await this.#behavior.cron?.(((await req.json()) as { name: string }).name));
      if (path === "/ctl/rows") {
        const { sql } = (await req.json()) as { sql: string };
        let text: string;
        try {
          text = assertReadOnlySql(sql);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
        // JSON has no bytes: a BLOB goes as {"$blob": base64} and workerd.ts turns it back into a Uint8Array.
        const rows = await this.#host.tx((s) => s.exec(text));
        return json(rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encodeValue(v)]))));
      }
      // Test hook: the platform's alarm entry, called with nothing due (an early or stale alarm).
      if (path === "/ctl/alarm") return json(await this.alarm());
      if (path === "/ctl/epoch") return json(this.#host.epoch());
      if (path === "/ctl/abort") {
        this.#meter.abandon(this.#token);
        this.ctx.abort("evicted by the test");
      }
      return json({ error: `no route ${path}` }, 404);
    } catch (e) {
      return fail(e);
    }
  }
}

export class Session extends ActorDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "s1");
  }
}
export class Sweeper extends ActorDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "sweeper");
  }
}
export class Profile extends ActorDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "profile");
  }
}

/** Model, executor and gateway, in the memory of one object. */
export class Services extends DurableObject<Env> {
  readonly #model: ModelService;
  readonly #exec = new ExecutorService();
  readonly #gateway = new GatewayService();
  /** The model calls in flight by idempotency key, so a cancel request can abort the one that waits. */
  readonly #calls = new Map<string, AbortController>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const o = optsOf(env);
    this.#model = new ModelService(o.script, o.modelDelayMs ?? 0);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/model") {
        const callId = req.headers.get("idempotency-key");
        const ac = new AbortController();
        if (callId !== null) this.#calls.set(callId, ac);
        try {
          return await this.#model.fetch(req, AbortSignal.any([req.signal, ac.signal]));
        } finally {
          if (callId !== null && this.#calls.get(callId) === ac) this.#calls.delete(callId);
        }
      }
      if (path === "/model/cancel") {
        const { callId } = (await req.json()) as { callId: string };
        this.#calls.get(callId)?.abort();
        return json(null);
      }
      if (path === "/executor/rpc" || path === "/gateway/rpc") {
        const { method, params } = (await req.json()) as { method: string; params: unknown };
        const h = path.startsWith("/executor") ? this.#exec.handle : this.#gateway.handle;
        return json(await h(method, params));
      }
      if (path === "/ctl/state") {
        return json({ replies: this.#gateway.replies, arrivals: this.#model.arrivals, aborts: this.#model.model.aborted, runs: this.#exec.runs() });
      }
      if (path === "/ctl/release") {
        const { name } = (await req.json()) as { name: string };
        this.#model.release(name);
        this.#exec.rig.commands.release(name);
        return json(null);
      }
      return json({ error: `no route ${path}` }, 404);
    } catch (e) {
      return fail(e);
    }
  }
}

interface Ctl {
  op?: string;
  actor?: ActorName;
  body?: unknown;
  rule?: StackFaultRule;
}

/** The front door of the harness: it forwards to the objects and answers for the module globals. */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const c = (await req.json()) as Ctl;
    const to = (f: FetcherLike, path: string, body: unknown) =>
      f.fetch(new Request(`http://do${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }));
    switch (url.pathname) {
      case "/actor": {
        const stub = actorStub(env, c.actor!);
        // An abort ends the request with an error: that is the eviction working.
        if (c.op === "/ctl/abort") return to(stub, c.op, {}).catch(() => json(null));
        return to(stub, c.op!, c.body);
      }
      case "/services":
        return to(servicesStub(env), c.op!, c.body);
      case "/crash-at":
        rules.add(c.rule!);
        return json(null);
      case "/crashes":
        return json(crashesFired);
      case "/meter":
        return json(meterOf(c.actor!).snapshot());
      case "/reset-meters":
        for (const m of meters.values()) m.reset();
        return json(null);
    }
    return json({ error: "not found" }, 404);
  },
};
