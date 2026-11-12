import { NodePlatform, type PlatformMode } from "@hermesd/host-node";
import { Meter, MeteredHost } from "./meter.ts";
import type { ActorName, Stack, StackOptions } from "./types.ts";
import { assertReadOnlySql } from "./readonly-sql.ts";
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
    platform.defineActor(name, (h) => {
      const host = new MeteredHost(h, { actor: name, meter });
      return meteredBehavior(make(host), meter, { token: host.token });
    });
  }
  // The jobs exist whatever autoSweep says, so `Stack.cron` always works; autoSweep only schedules them.
  const auto = opts.autoSweep !== false;
  platform.cron("sweeper", "tick", 60_000, auto);
  platform.cron("sweeper", "sweep", 600_000, auto);
  // A dead activation's open spans would otherwise stay open for good: its promises never settle.
  platform.onCrash((key) => meters.get(key as ActorName)?.abandon());
  await platform.call("profile", "register_session", { session: NAMES.session });
  let crashes = 0;
  const minDelay = opts.minDelayMs ?? 1_000;

  return {
    host: "node",
    async send(input, request = `req-${Math.random().toString(36).slice(2)}`) {
      await platform.call("s1", "receive", { principal: "user-1", session: "s1", request, input });
    },
    replies: async () => [...gateway.replies],
    async waitReplies(n, timeoutMs = 30_000) {
      // The deadline is real time and is checked here, in a loop that never awaits the clock: a held
      // model call keeps the platform busy, so `advance` (which waits for it to be idle) may not return.
      // Virtual time is pumped by an advance that runs on its own, one at a time.
      const end = Date.now() + timeoutMs;
      let pumping: Promise<void> | undefined;
      for (let i = 0; gateway.replies.length < n; i++) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${n} replies (have ${gateway.replies.length})`);
        await tick();
        if (i % 50 === 49 && !pumping) {
          pumping = platform.clock.advance(minDelay + 100).catch(() => {}).finally(() => void (pumping = undefined));
        }
      }
      return [...gateway.replies];
    },
    call: (actor, method, params) => platform.call(actor, method, params),
    rows: async (actor, sql) => platform.query(actor, assertReadOnlySql(sql)),
    evict: async (actor) => platform.crash(actor),
    epochOf: async (actor) => platform.epochOf(actor),
    crashAt: async (rule) => {
      const point = { actor: rule.actor, point: rule.point, ...(rule.detail ? { detail: rule.detail } : {}), ...(rule.nth ? { nth: rule.nth } : {}) };
      platform.crashAt(point);
      // A hook rule on the same point matches the same event, so it counts the crash that rule makes.
      platform.onPoint(point, () => void (crashes += 1));
    },
    advance: (ms) => platform.clock.advance(ms),
    crashesFired: async () => crashes,
    release: async (name) => {
      model.release(name);
      exec.rig.commands.release(name);
    },
    // Dispatch the named job alone; the virtual clock does not move.
    cron: (name) => platform.runCron("sweeper", name),
    meter: async (actor) => meters.get(actor)!.snapshot(),
    resetMeters: async () => {
      for (const m of meters.values()) m.reset();
    },
    modelArrivals: async () => [...model.arrivals],
    modelAborts: async () => model.model.aborted,
    executorRuns: async () => exec.runs(),
    close: async () => platform.close(),
  };
}
