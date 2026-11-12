import { NodePlatform, type PlatformMode } from "@hermesd/host-node";
import { Meter, MeteredHost } from "./meter.ts";
import type { ActorName, Stack, StackOptions } from "./types.ts";
import { ExecutorService, GatewayService, ModelService, NAMES, actorFactory, meteredBehavior } from "./world.ts";

const ACTORS: ActorName[] = ["s1", "sweeper", "profile"];
const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * The world on the in-memory Node simulator. Its clock is virtual: waiting moves it.
 * Counts are exact; wall times are of the simulator, not of a platform.
 */
export async function createNodeStack(opts: StackOptions, mode: PlatformMode = "durable-objects"): Promise<Stack> {
  const model = new ModelService(opts.script, opts.modelDelayMs ?? 0);
  const platform = new NodePlatform({ mode, fetch: (req, signal) => model.fetch(req, signal) });
  const exec = new ExecutorService();
  const gateway = new GatewayService();
  platform.registerSidecar(NAMES.executor, exec.handle);
  platform.registerSidecar(NAMES.gateway, gateway.handle);
  const meters = new Map<ActorName, Meter>();
  for (const name of ACTORS) {
    const meter = new Meter();
    meters.set(name, meter);
    const make = actorFactory(name, opts, platform.clock);
    platform.defineActor(name, (h) => meteredBehavior(make(new MeteredHost(h, { actor: name, meter })), meter));
  }
  platform.cron("sweeper", "tick", 60_000);
  platform.cron("sweeper", "sweep", 600_000);
  await platform.call("profile", "register_session", { session: NAMES.session });
  const minDelay = opts.minDelayMs ?? 1_000;

  return {
    host: "node",
    async send(input, request = `req-${Math.random().toString(36).slice(2)}`) {
      await platform.call("s1", "receive", { principal: "user-1", session: "s1", request, input });
    },
    replies: async () => [...gateway.replies],
    async waitReplies(n, timeoutMs = 30_000) {
      const end = Date.now() + timeoutMs;
      for (let i = 0; gateway.replies.length < n; i++) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${n} replies (have ${gateway.replies.length})`);
        await tick();
        if (i % 50 === 49) await platform.clock.advance(minDelay + 100);
      }
      return [...gateway.replies];
    },
    call: (actor, method, params) => platform.call(actor, method, params),
    rows: async (actor, sql) => platform.query(actor, sql),
    evict: async (actor) => platform.crash(actor),
    crashAt: async (rule) => platform.crashAt({ actor: rule.actor, point: rule.point, ...(rule.detail ? { detail: rule.detail } : {}), ...(rule.nth ? { nth: rule.nth } : {}) }),
    release: async (name) => {
      model.release(name);
      exec.rig.commands.release(name);
    },
    // The platform cron runs on the virtual clock: move it one period.
    cron: (name) => platform.clock.advance(name === "tick" ? 60_000 : 600_000),
    meter: async (actor) => meters.get(actor)!.snapshot(),
    resetMeters: async () => {
      for (const m of meters.values()) m.reset();
    },
    modelArrivals: async () => [...model.arrivals],
    executorRuns: async () => exec.runs(),
    close: async () => platform.close(),
  };
}
