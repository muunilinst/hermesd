import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { CloudflareHost, type FetcherLike } from "@hermesd/host-cloudflare";
import type { ActorBehavior } from "@hermesd/runtime";
import { FaultRules, Meter, MeteredHost } from "./meter.ts";
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
const meterOf = (a: ActorName): Meter => {
  let m = meters.get(a);
  if (!m) meters.set(a, (m = new Meter()));
  return m;
};
const clock = { now: () => Date.now() };
const json = (v: unknown, status = 200) => Response.json(v ?? null, { status });
const optsOf = (env: Env): StackOptions => JSON.parse(env.OPTS) as StackOptions;
const fail = (e: unknown) => json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, 500);

const BINDING = { s1: "SESSION", sweeper: "SWEEPER", profile: "PROFILE" } as const;
const actorStub = (env: Env, a: ActorName): FetcherLike => env[BINDING[a]].get(env[BINDING[a]].idFromName(a));
const servicesStub = (env: Env): FetcherLike => env.SERVICES.get(env.SERVICES.idFromName("services"));
const viaServices = (env: Env, path: string): FetcherLike => ({
  fetch: (req) => servicesStub(env).fetch(new Request(`http://services${path}`, req)),
});

class ActorDO extends DurableObject<Env> {
  readonly #host: CloudflareHost;
  readonly #behavior: ActorBehavior;
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
    this.#host = new CloudflareHost(ctx, { sidecars, fetch: (req) => viaServices(env, "/model").fetch(req) });
    const meter = meterOf(name);
    const host = new MeteredHost(this.#host, { actor: name, meter, rules, crash: () => ctx.abort("injected crash") });
    this.#behavior = meteredBehavior(actorFactory(name, optsOf(env), clock)(host), meter);
    this.#host.onAlarm(async () => void (await this.#behavior.alarm?.()));
  }

  /** `activate()` runs once per instance, after the epoch is durable, before the first event. */
  #ready(): Promise<void> {
    this.#active ??= this.#host.ready.then(() => this.#behavior.activate?.());
    return this.#active;
  }

  async alarm(): Promise<void> {
    await this.#ready();
    await this.#host.handleAlarm();
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
        if (!/^\s*select\b/i.test(sql)) return json({ error: "read-only: SELECT only" }, 400);
        return json(await this.#host.tx((s) => s.exec(sql)));
      }
      if (path === "/ctl/abort") this.ctx.abort("evicted by the test");
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const o = optsOf(env);
    this.#model = new ModelService(o.script, o.modelDelayMs ?? 0);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/model") return await this.#model.fetch(req);
      if (path === "/executor/rpc" || path === "/gateway/rpc") {
        const { method, params } = (await req.json()) as { method: string; params: unknown };
        const h = path.startsWith("/executor") ? this.#exec.handle : this.#gateway.handle;
        return json(await h(method, params));
      }
      if (path === "/ctl/state") {
        return json({ replies: this.#gateway.replies, arrivals: this.#model.arrivals, runs: this.#exec.runs() });
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
      case "/meter":
        return json(meterOf(c.actor!).snapshot());
      case "/reset-meters":
        for (const m of meters.values()) m.reset();
        return json(null);
    }
    return json({ error: "not found" }, 404);
  },
};
