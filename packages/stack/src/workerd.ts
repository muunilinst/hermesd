import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorName, MeterSnapshot, ModelArrival, Stack, StackFaultRule, StackOptions, StackReply } from "./types.ts";
import type { SqlRow } from "@hermesd/host";

/**
 * The world on real local workerd through Miniflare: Durable Objects with SQLite
 * storage, real time. The worker (`workerd-worker.ts`) is bundled with Bun.build at
 * the first stack; each stack gets its own Miniflare, so state never leaks between
 * scenarios.
 *
 * Crons: the platform's cron triggers are not run by Miniflare here. The harness
 * calls the sweeper's `tick` every `tickEveryMs` (default 5 s) and `sweep` every
 * `sweepEveryMs` (default five ticks) from the test side, so catch-up and stuck-turn recovery work without help; `Stack.cron` runs a job at once.
 */
interface Mf {
  dispatchFetch(url: string, init?: RequestInit): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;
  dispose(): Promise<void>;
  ready: Promise<unknown>;
}

export interface WorkerdStackOptions extends StackOptions {
  /** Period of the harness-driven sweeper tick, in ms. 0 turns it off. Default 5000. */
  tickEveryMs?: number;
  /** Period of the harness-driven sweeper sweep (stuck-turn recovery), in ms. Default five ticks. 0 turns it off. */
  sweepEveryMs?: number;
}

/** Undo the worker's encoding of BLOB values (`{"$blob": base64}`) so `rows()` matches the other hosts. */
function decodeValue(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $blob?: unknown }).$blob === "string") {
    return new Uint8Array(Buffer.from((v as { $blob: string }).$blob, "base64"));
  }
  return v;
}

// Bun is the runtime of the tests; its types are not in this repo's tsconfig.
const bun = (globalThis as unknown as { Bun: { build(o: object): Promise<{ success: boolean; logs: unknown[]; outputs: Array<{ text(): Promise<string> }> }> } }).Bun;
let bundle: Promise<string> | undefined;

/** Bundle the worker. `cloudflare:workers` is the platform's own module. */
function bundleWorker(): Promise<string> {
  bundle ??= (async () => {
    const out = await bun.build({
      entrypoints: [join(import.meta.dirname, "workerd-worker.ts")],
      target: "browser",
      format: "esm",
      external: ["cloudflare:workers"],
    });
    if (!out.success) throw new Error(`bundling the worker failed: ${out.logs.map(String).join("\n")}`);
    return out.outputs[0]!.text();
  })();
  return bundle;
}

export async function createWorkerdStack(opts: WorkerdStackOptions): Promise<Stack> {
  const { Miniflare } = await import("miniflare");
  const { tickEveryMs = 5_000, sweepEveryMs = tickEveryMs * 5, ...stackOpts } = opts;
  const worker = await bundleWorker();
  const persist = mkdtempSync(join(tmpdir(), "hermesd-stack-"));
  let mf: Mf | undefined;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  // Everything acquired so far is released by `release`, whether setup fails or `close` runs.
  const release = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const t of timers.splice(0)) clearInterval(t);
    try {
      await mf?.dispose();
    } catch (e) {
      errors.push(e);
    }
    try {
      rmSync(persist, { recursive: true, force: true });
    } catch (e) {
      errors.push(e);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "workerd stack teardown failed");
  };
  try {
    mf = new Miniflare({
      modules: [{ type: "ESModule", path: "worker.js", contents: worker }],
      compatibilityDate: "2026-07-01",
      durableObjects: {
        SESSION: { className: "Session", useSQLite: true },
        SWEEPER: { className: "Sweeper", useSQLite: true },
        PROFILE: { className: "Profile", useSQLite: true },
        SERVICES: { className: "Services", useSQLite: true },
      },
      durableObjectsPersist: persist,
      bindings: { OPTS: JSON.stringify(stackOpts) },
    } as never) as unknown as Mf;
    await mf.ready;
    return await build(mf);
  } catch (e) {
    await release().catch(() => undefined);
    throw e;
  }

  async function build(mf: Mf): Promise<Stack> {
  const post = async (path: string, body: unknown = {}): Promise<unknown> => {
    const res = await mf.dispatchFetch(`http://stack.test${path}`, { method: "POST", body: JSON.stringify(body) });
    const v = (await res.json()) as unknown;
    if (res.status >= 400) throw new Error(`${path} ${JSON.stringify(body).slice(0, 120)}: ${res.status} ${JSON.stringify(v)}`);
    return v;
  };
  const actor = (a: ActorName, op: string, body?: unknown) => post("/actor", { actor: a, op, body });
  const services = (op: string, body?: unknown) => post("/services", { op, body });
  const state = async () => (await services("/ctl/state")) as { replies: StackReply[]; arrivals: ModelArrival[]; runs: number };

  let closed = false;
  // Register the session with the profile actor, as the node stack does.
  await actor("profile", "/rpc", { method: "register_session", params: { session: "s1" } });
  if (stackOpts.autoSweep !== false) {
    for (const [name, every] of [["tick", tickEveryMs], ["sweep", sweepEveryMs]] as const) {
      if (every > 0) timers.push(setInterval(() => void actor("sweeper", "/ctl/cron", { name }).catch(() => undefined), every));
    }
  }

  return {
    host: "workerd",
    async send(input, request = `req-${Math.random().toString(36).slice(2)}`) {
      await actor("s1", "/rpc", { method: "receive", params: { principal: "user-1", session: "s1", request, input } });
    },
    replies: async () => (await state()).replies,
    async waitReplies(n, timeoutMs = 30_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const r = (await state()).replies;
        if (r.length >= n) return r;
        if (Date.now() > end) throw new Error(`timed out waiting for ${n} replies (have ${r.length})`);
        await new Promise((res) => setTimeout(res, 25));
      }
    },
    call: (a, method, params) => actor(a, "/rpc", { method, params }),
    rows: async (a, sql) =>
      ((await actor(a, "/ctl/rows", { sql })) as Array<Record<string, unknown>>).map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, decodeValue(v)])),
      ) as SqlRow[],
    // The abort ends the request; nothing follows it, so the actor stays out of memory until the next event.
    evict: async (a) => void (await actor(a, "/ctl/abort")),
    epochOf: async (a) => Number(await actor(a, "/ctl/epoch")),
    advance: (ms) => new Promise((r) => setTimeout(r, ms)),
    crashesFired: async () => Number(await post("/crashes")),
    crashAt: async (rule: StackFaultRule) => void (await post("/crash-at", { rule })),
    release: async (name) => void (await services("/ctl/release", { name })),
    cron: async (name) => void (await actor("sweeper", "/ctl/cron", { name })),
    meter: async (a) => (await post("/meter", { actor: a })) as MeterSnapshot,
    resetMeters: async () => void (await post("/reset-meters")),
    modelArrivals: async () => (await state()).arrivals,
    executorRuns: async () => (await state()).runs,
    async close() {
      if (closed) return;
      closed = true;
      await release();
    },
  };
  }
}
