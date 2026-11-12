import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
export type RivetStack = Stack & {
  ghostsDestroyed(): number;
  /** Where this stack's engine keeps its data. */
  readonly storagePath: string;
  /** Deliver a timer action to the actor for a key with no wake timer row (a stale or early timer). */
  emptyAlarm(actor: ActorName): Promise<void>;
  /** Activations of the stack's actors that are running now (each holds a host mirror); zero once they stopped. */
  liveActivations(): number;
};

/**
 * Sets (or with `undefined`, removes) an environment variable where the rivetkit native core reads it. Under
 * Node `process.env` is the C environment. Under Bun it is not: an assignment to `process.env` reaches child
 * processes but not `getenv` in a native addon, so the core would never see RIVETKIT_STORAGE_PATH. Bun gets
 * libc `setenv`/`unsetenv` as well.
 */
async function setNativeEnv(key: string, value: string | undefined): Promise<void> {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  if (!(globalThis as { Bun?: unknown }).Bun) return;
  const ffi = (await import("bun:ffi" as string)) as Any;
  const libc = ffi.dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    setenv: { args: [ffi.FFIType.cstring, ffi.FFIType.cstring, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
    unsetenv: { args: [ffi.FFIType.cstring], returns: ffi.FFIType.i32 },
  });
  const c = (x: string): Buffer => Buffer.from(`${x}\0`);
  if (value === undefined) libc.symbols.unsetenv(c(key));
  else libc.symbols.setenv(c(key), c(value), 1);
  libc.close();
}

/**
 * rivetkit 3.0.7 has no per-registry storage setting: the native engine takes its data directory from
 * RIVETKIT_STORAGE_PATH in the environment of the process that starts it (the serve config has only
 * `enginePort`), and reads it once, at spawn. So the variable is set only while the engine starts, and put
 * back as soon as the start returns; nothing is restored later, so a path that a closed stack deleted is
 * never written back.
 *
 * Only one stack can be open per process: every registry of the process talks to the one local engine
 * (fixed port), which hands an actor to any registry that registered its name, so two stacks would serve
 * each other's actors (the ghost guard in rivet-actors.ts would destroy them). `createRivetStack` refuses
 * to start while another stack is open, with an error that says so, instead of picking the wrong store or
 * the wrong registry. Two processes may run stacks at once, each with its own store.
 */
let openStack = false;
async function withStoragePath<T>(path: string, start: () => Promise<T>): Promise<T> {
  const prior = process.env["RIVETKIT_STORAGE_PATH"];
  try {
    await setNativeEnv("RIVETKIT_STORAGE_PATH", path);
    return await start();
  } finally {
    await setNativeEnv("RIVETKIT_STORAGE_PATH", prior);
  }
}

export interface RivetStackOptions extends StackOptions {
  /**
   * Where the engine keeps its data. The default is a new temporary directory for this stack, removed on
   * `close`, so no run meets the actors, rows or timers of another. Give a directory only to share a store
   * on purpose (the two-process regression test); it is then left in place.
   */
  storagePath?: string;
}

export async function createRivetStack(options: RivetStackOptions): Promise<RivetStack> {
  if (openStack) {
    throw new Error("createRivetStack: another rivet stack is open in this process. They share one local engine and cannot overlap; close the first (or use a separate process).");
  }
  openStack = true;
  try {
    return await startRivetStack(options);
  } catch (e) {
    openStack = false;
    throw e;
  }
}

async function startRivetStack(options: RivetStackOptions): Promise<RivetStack> {
  const { storagePath, ...opts } = options;
  const { actor, setup } = (await import("rivetkit")) as Any;
  const { db } = (await import("rivetkit/db")) as Any;
  const { setupTest } = (await import("rivetkit/test")) as Any;

  // The engine takes its data directory from RIVETKIT_STORAGE_PATH when it starts (see `withStoragePath`); unset, ~/.rivetkit.
  const ownedStore = storagePath === undefined ? mkdtempSync(join(tmpdir(), "hermesd-rivet-")) : undefined;
  const store = storagePath ?? ownedStore!;
  const releaseStore = (): void => {
    openStack = false;
    if (ownedStore) rmSync(ownedStore, { recursive: true, force: true });
  };

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
    activations: new Map(),
    client: () => client,
    // The store is private to the stack (see `storagePath`), and keys are new per stack as well, so a
    // shared store still never hands a stack the rows of an earlier one;
    // the actor still answers to its logical name through `Host.id()` (see rivet-actors.ts).
    keys: { s1: [`${run}-s1`], sweeper: [`${run}-sweeper`], profile: [`${run}-profile`] },
  };
  const use = Object.fromEntries(ACTOR_NAMES.map((n) => [n, defineWorldActor(n, world, { actor, db })]));
  // The stack needs no first-party Services actor host; leaving it on also ties every run to one fixed port.
  const registry = setup({ use, startServices: false });
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
    try {
      releaseStore();
    } catch (e) {
      errors.push(e);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "rivet stack teardown failed");
  };
  try {
    ({ client } = await withStoragePath<Any>(store, () => setupTest({ onTestFinished: (f: () => Promise<void>) => finishers.push(f) }, registry)));
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
    storagePath: store,
    emptyAlarm: async (a) => void (await handle(a).hostWake("no-such-timer")),
    liveActivations: () => world.activations.size,
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
    modelAborts: async () => model.model.aborted,
    executorRuns: async () => exec.runs(),
    async close() {
      if (closed) return;
      closed = true;
      await teardown();
    },
  };
}
