import type { Host } from "@hermesd/host";
import { RivetHost, type ActorLike, type FetcherLike } from "@hermesd/host-rivet";
import type { ActorBehavior, Clock } from "@hermesd/runtime";
import { FaultRules, Meter, MeteredHost } from "./meter.ts";
import type { ActorName, StackOptions } from "./types.ts";
import { assertReadOnlySql } from "./readonly-sql.ts";
import { ExecutorService, GatewayService, ModelService, NAMES, actorFactory, actorOfTarget, meteredBehavior } from "./world.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * The milestone 1 world as rivetkit actors. The three services live in the process
 * that built the registry, outside the actors, so they survive an actor restart
 * (as the executor and the gateway would on a real deployment).
 */
export interface RivetWorld {
  opts: StackOptions;
  model: ModelService;
  exec: ExecutorService;
  gateway: GatewayService;
  meters: Map<ActorName, Meter>;
  rules: FaultRules;
  /** A rivetkit client, set once the registry runs. Actors reach each other through it. */
  client: () => Any;
  /** Wakes of actors that belong to an earlier stack or process, which were destroyed (see `wake`). */
  ghosts: { destroyed: number };
  /** Injected crashes that acted. */
  crashes: { fired: number };
  /** How many activations of each actor of this stack have gone to sleep (`onSleep`). */
  sleeps: Record<ActorName, number>;
  /** The running activations by actor id: the host mirror and the meter token each holds. Empty once every actor stopped. */
  activations: Map<string, Activation>;
  /** The rivetkit key of each actor, unique per stack. */
  keys: Record<ActorName, string[]>;
}

/** What an activation of an actor holds while it runs, and gives back when it stops. */
export interface Activation {
  raw: RivetHost;
  /** Tags this activation's spans in the actor's meter. */
  token: number;
  behavior?: ActorBehavior;
}

export const ACTOR_NAMES: ActorName[] = ["s1", "sweeper", "profile"];
const clock: Clock = { now: () => Date.now() };

/**
 * How long an idle actor stays in memory. The behavior starts its turns as detached
 * promises (`void fn()` in the runtime), which are not under `keepAwake`, so the
 * timeout must be longer than any turn of a test. See rivet.ts.
 */
export const SLEEP_TIMEOUT_MS = 1_000;
/** How long the platform waits for a graceful sleep. Short, so `c.sleep()` is close to a crash. */
export const SLEEP_GRACE_MS = 100;

/** A sidecar over a handler function: the `POST /rpc {method, params}` shape of the adapter. */
function fetcher(handle: (method: string, params: unknown) => Promise<unknown>): FetcherLike {
  return {
    async fetch(req) {
      const { method, params } = (await req.json()) as { method: string; params: unknown };
      try {
        return Response.json((await handle(method, params)) ?? null);
      } catch (e) {
        return new Response(String(e instanceof Error ? e.message : e), { status: 500 });
      }
    },
  };
}

export function sidecarsFor(w: RivetWorld): Record<string, FetcherLike> {
  const out: Record<string, FetcherLike> = {
    [NAMES.executor]: fetcher(w.exec.handle),
    [NAMES.gateway]: fetcher(w.gateway.handle),
  };
  // Actor to actor: a call through the rivetkit client.
  for (const t of [NAMES.sweeper, NAMES.profile, NAMES.actorTarget(NAMES.session)]) {
    const target = actorOfTarget(t)!;
    out[t] = fetcher((method, params) => w.client()[target].getOrCreate(w.keys[target]).call(method, params));
  }
  return out;
}

/** Build the actor definition for one actor of the world. */
export function defineWorldActor(name: ActorName, w: RivetWorld, rivet: { actor: Any; db: Any }): Any {
  const make = actorFactory(name, w.opts, clock);
  const meter = w.meters.get(name)!;
  const behavior = (c: Pick<ActorLike, "actorId">): ActorBehavior => {
    const b = w.activations.get(c.actorId)?.behavior;
    if (!b) throw new Error(`actor ${name} is not activated`);
    return b;
  };
  const isOurs = (c: Any): boolean => {
    const key: unknown = c.key;
    const mine = w.keys[name];
    return Array.isArray(key) && key.length === mine.length && key.every((k, i) => k === mine[i]);
  };
  const wake = async (c: Any): Promise<void> => {
    // The engine keeps its store across stacks and processes, and an actor of an earlier stack
    // with a timer still armed is woken by the engine of this one, under this registry (it has
    // this world's closures, the logical id "s1" and the new sweeper's key). Such a ghost raises its
    // own owner epoch and fences the live session at the sweeper. It is not ours: destroy it, which
    // also removes its schedules.
    if (!isOurs(c)) {
      w.ghosts.destroyed += 1;
      c.destroy();
      return;
    }
    // Rule 1: activate first. It loads the mirror and raises the owner epoch durably.
    const raw = await RivetHost.activate(c, {
      sidecars: sidecarsFor(w),
      onWrite: (kind) => meter.adapterWrite(kind),
      fetch: (req) => w.model.fetch(req, req.signal),
      // The retry delay of a failed timer handler. Short, so a test does not wait a minute.
      retryDelayMs: Math.max(1_000, w.opts.minDelayMs ?? 1_000),
    });
    // A crash point kills this activation the way rivetkit allows: it puts the actor to sleep.
    // `Host.id()` is the actor key, and the session checks it against its own id ("s1"). The key
    // is unique per stack, so the host answers with the logical name. Nothing else changes.
    const named: Host = {
      id: () => name === "s1" ? NAMES.session : name,
      epoch: () => raw.epoch(),
      tx: (fn) => raw.tx(fn),
      commit: () => raw.commit(),
      arm: (at, key) => raw.arm(at, key),
      disarm: (key) => raw.disarm(key),
      keepAwake: (work) => raw.keepAwake(work),
      fetch: (req, signal) => raw.fetch(req, signal),
      sidecar: (n) => raw.sidecar(n),
    };
    const host = new MeteredHost(named, { actor: name, meter, rules: w.rules, crash: () => {
        w.crashes.fired += 1;
        c.sleep();
      } });
    // Registered before the first await that can fail, so `onSleep` always finds what to give back.
    const act: Activation = { raw, token: host.token };
    w.activations.set(c.actorId, act);
    // Alarms are metered once, at the `hostWake` action, before the adapter decides whether work is due.
    const b = meteredBehavior(make(host), meter, { token: host.token, alarms: false });
    act.behavior = b;
    // A timer fires: hostWake -> handleWake re-arms first, then calls this -> behavior.alarm().
    raw.onWake(async () => {
      await b.alarm?.();
    });
    // The behavior starts its own background work from activate (adopt, deliver, kick):
    // detached promises started here, in onWake, not inside an action.
    await b.activate?.();
  };
  return rivet.actor({
    db: rivet.db(),
    options: { sleepTimeout: SLEEP_TIMEOUT_MS, sleepGracePeriod: SLEEP_GRACE_MS },
    onWake: wake,
    onSleep: (c: Any) => {
      // The stopped activation's open spans end now (a held or dropped request would charge idle time for
      // good), and its host mirror is closed and unregistered. The replacement activation's spans and host
      // are other objects: abandon(token) and close() touch only this activation's.
      const act = w.activations.get(c.actorId);
      w.activations.delete(c.actorId);
      if (act) {
        meter.abandon(act.token);
        act.raw.close();
      }
      if (isOurs(c)) w.sleeps[name] += 1;
    },
    actions: {
      call: (c: Any, method: string, params: unknown) => behavior(c).call(method, params),
      cron: (c: Any, cronName: string) => behavior(c).cron!(cronName),
      hostWake: async (c: Any, key: string) => {
        const act = w.activations.get(c.actorId);
        const host = RivetHost.of(c);
        await meter.event(() => host.handleWake(key), "alarm", act?.token);
      },
      epoch: (c: Any) => RivetHost.of(c).epoch(),
      rows: (c: Any, sql: string) => {
        const text = assertReadOnlySql(sql);
        return RivetHost.of(c).tx((s) => s.exec(text));
      },
      sleepNow: (c: Any) => c.sleep(),
    },
  });
}
