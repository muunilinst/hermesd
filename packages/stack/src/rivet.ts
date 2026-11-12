import type { SqlRow } from "@hermesd/host";
import { FaultRules, Meter } from "./meter.ts";
import { ACTOR_NAMES, defineWorldActor, type RivetWorld } from "./rivet-actors.ts";
import type { ActorName, Stack, StackOptions } from "./types.ts";
import { ExecutorService, GatewayService, ModelService, NAMES } from "./world.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * The world on real rivetkit 3.0.7 (native engine, in this process, through
 * `rivetkit/test` `setupTest`). Time is real: waiting waits.
 *
 * Choices, each with its reason:
 *
 * - The turn. The runtime hands the work it starts in the background (the turn
 *   loop, outbox delivery, adoption) to `Host.keepAwake`, which RivetHost maps to
 *   `c.keepAwake`. `sleepTimeout` is 1 s, shorter than a held model call in the
 *   scenarios, so a turn that was not kept awake would be cut off by an idle sleep.
 * - Crons. `Stack.cron(name)` calls `behavior.cron(name)` through an action. In
 *   addition, the harness runs "tick" every 3 s and "sweep" every 15 s from a timer
 *   in the test process (a stand-in for a platform cron), so outbox catch-up and
 *   stuck-turn recovery work without help. Rivet has no cron of its own in this
 *   adapter; a deployment would use a schedule on the sweeper actor.
 * - `evict(actor)`: the actor is put to sleep with `c.sleep()` (`sleepGracePeriod`
 *   100 ms). That is rivetkit's own way to stop an actor; its DB is closed under the
 *   running activation, which is not told, so a turn in flight fails at its next
 *   write. `evict` returns once the activation's `onSleep` ran, without sending the
 *   actor anything: the next request wakes it (`epochOf` shows the new epoch).
 * - `crashAt`: the same `c.sleep()`, called by `MeteredHost` at the fault point,
 *   followed by a throw that unwinds the activation. rivetkit 3.0.7 has a hard crash
 *   (`hardCrashActor`) only on its test driver and does not expose it, so a process
 *   kill is not available. `c.destroy()` would delete the data. A sleep at the exact
 *   point, with the DB closed and no further durable write from that activation, is
 *   the closest. It is not a process kill: the old activation's memory lives on until
 *   it unwinds, and a sleeping actor flushes what it has already committed.
 */
export class RivetUnavailable extends Error {}

/** The rivet stack, with what only it can show: ghost actors of an earlier process that the engine woke and the guard destroyed. */
export type RivetStack = Stack & { ghostsDestroyed(): number };

export async function createRivetStack(opts: StackOptions): Promise<RivetStack> {
  const { actor, setup } = (await import("rivetkit")) as Any;
  const { db } = (await import("rivetkit/db")) as Any;
  const { setupTest } = (await import("rivetkit/test")) as Any;

  const model = new ModelService(opts.script, opts.modelDelayMs ?? 0);
  const exec = new ExecutorService();
  const gateway = new GatewayService();
  let client: Any;
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const world: RivetWorld = {
    opts,
    model,
    exec,
    gateway,
    meters: new Map(ACTOR_NAMES.map((n) => [n, new Meter()])),
    rules: new FaultRules(),
    ghosts: { destroyed: 0 },
    crashes: { fired: 0 },
    sleeps: { s1: 0, sweeper: 0, profile: 0 },
    client: () => client,
    // The engine keeps its data under ~/.rivetkit and an actor id follows from its key, so a key
    // that repeats would meet the rows of an earlier stack or run. Each stack gets new keys;
    // the actor still answers to its logical name through `Host.id()` (see rivet-actors.ts).
    keys: { s1: [`${run}-s1`], sweeper: [`${run}-sweeper`], profile: [`${run}-profile`] },
  };
  const use = Object.fromEntries(ACTOR_NAMES.map((n) => [n, defineWorldActor(n, world, { actor, db })]));
  const registry = setup({ use });
  const finishers: Array<() => Promise<void> | void> = [];
  const crons: Array<ReturnType<typeof setInterval>> = [];
  // Release what was acquired, each step on its own: one failure does not stop the next. Errors are rethrown together.
  const teardown = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const t of crons) clearInterval(t);
    world.rules.clear();
    for (const f of finishers.splice(0)) {
      try {
        await f();
      } catch (e) {
        errors.push(e);
      }
    }
    try {
      await registry.shutdown();
    } catch (e) {
      errors.push(e);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "rivet stack teardown failed");
  };
  try {
    ({ client } = await setupTest({ onTestFinished: (f: () => Promise<void>) => finishers.push(f) }, registry));
  } catch (e) {
    await teardown().catch(() => {});
    throw new RivetUnavailable(`rivetkit could not start here: ${(e as Error).message.slice(0, 200)}`);
  }

  const handle = (a: ActorName): Any => client[a].getOrCreate(world.keys[a]);

  try {
    if (opts.autoSweep !== false) {
      // Stand-in for the platform cron of the sweeper.
      crons.push(
        setInterval(() => void handle("sweeper").cron("tick").catch(() => {}), 3_000),
        setInterval(() => void handle("sweeper").cron("sweep").catch(() => {}), 15_000),
      );
    }
    await handle("profile").call("register_session", { session: NAMES.session });
  } catch (e) {
    await teardown().catch(() => {});
    throw e;
  }

  const epoch = (a: ActorName): Promise<number> => handle(a).epoch();
  let closed = false;

  return {
    host: "rivet",
    async send(input, request = `req-${Math.random().toString(36).slice(2)}`) {
      await handle("s1").call("receive", { principal: "user-1", session: "s1", request, input });
    },
    replies: async () => [...gateway.replies],
    async waitReplies(n, timeoutMs = 30_000) {
      const end = Date.now() + timeoutMs;
      while (gateway.replies.length < n) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${n} replies (have ${gateway.replies.length})`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return [...gateway.replies];
    },
    call: (a, method, params) => handle(a).call(method, params),
    rows: async (a, sql) => (await handle(a).rows(sql)) as SqlRow[],
    async evict(a) {
      const before = world.sleeps[a];
      await handle(a).sleepNow();
      const end = Date.now() + 20_000;
      // Wait for the activation's own `onSleep`, which is seen in this process. Nothing is sent to the
      // actor meanwhile, so it is not woken: the next request is the one that activates it again.
      while (world.sleeps[a] <= before) {
        if (Date.now() > end) throw new Error(`${a} did not go to sleep after c.sleep()`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    epochOf: async (a) => Number(await epoch(a)),
    advance: (ms) => new Promise((r) => setTimeout(r, ms)),
    crashesFired: async () => world.crashes.fired,
    ghostsDestroyed: () => world.ghosts.destroyed,
    crashAt: async (rule) => world.rules.add(rule),
    release: async (name) => {
      model.release(name);
      exec.rig.commands.release(name);
    },
    cron: (name) => handle("sweeper").cron(name),
    meter: async (a) => world.meters.get(a)!.snapshot(),
    resetMeters: async () => {
      for (const m of world.meters.values()) m.reset();
    },
    modelArrivals: async () => [...model.arrivals],
    executorRuns: async () => exec.runs(),
    async close() {
      if (closed) return;
      closed = true;
      await teardown();
    },
  };
}
