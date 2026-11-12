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
 * calls the sweeper's `tick` itself every `tickEveryMs` (default 5 s) from the test
 * side, so catch-up works without help; `Stack.cron` runs a job at once.
 */
interface Mf {
  dispatchFetch(url: string, init?: RequestInit): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;
  dispose(): Promise<void>;
  ready: Promise<unknown>;
}

export interface WorkerdStackOptions extends StackOptions {
  /** Period of the harness-driven sweeper tick, in ms. 0 turns it off. Default 5000. */
  tickEveryMs?: number;
}

// Bun is the runtime of the tests; its types are not in this repo's tsconfig.
const bun = (globalThis as unknown as { Bun: { build(o: object): Promise<{ success: boolean; logs: unknown[]; outputs: Array<{ text(): Promise<string> }> }> } }).Bun;
let bundle: Promise<string> | undefined;

/**
 * `@hermesd/contracts` reads the committed upstream JSON from the file system at run
 * time (`readFileSync` on a `file:` URL), which workerd has not. The session actor
 * needs `tool-schemas.json`; the bundle gets it as data, from the same file.
 */
const contractsPlugin = {
  name: "contracts-as-data",
  setup(b: { onResolve(o: { filter: RegExp }, f: () => object): void; onLoad(o: { filter: RegExp; namespace: string }, f: () => object): void }) {
    b.onResolve({ filter: /^@hermesd\/contracts$/ }, () => ({ path: "contracts", namespace: "contracts-data" }));
    b.onLoad({ filter: /.*/, namespace: "contracts-data" }, () => {
      const json = join(import.meta.dirname, "..", "..", "..", "contracts", "upstream", "tool-schemas.json");
      return {
        loader: "js",
        contents:
          `import toolSchemas from ${JSON.stringify(json)};\n` +
          `const data = { "tool-schemas": toolSchemas };\n` +
          `export const loadSurface = (n) => { if (!(n in data)) throw new Error("contract " + n + " is not in the workerd bundle"); return data[n]; };\n`,
      };
    });
  },
};

/** Bundle the worker. `cloudflare:workers` is the platform's own module. */
function bundleWorker(): Promise<string> {
  bundle ??= (async () => {
    const out = await bun.build({
      entrypoints: [join(import.meta.dirname, "workerd-worker.ts")],
      target: "browser",
      format: "esm",
      external: ["cloudflare:workers"],
      plugins: [contractsPlugin],
    });
    if (!out.success) throw new Error(`bundling the worker failed: ${out.logs.map(String).join("\n")}`);
    return out.outputs[0]!.text();
  })();
  return bundle;
}

export async function createWorkerdStack(opts: WorkerdStackOptions): Promise<Stack> {
  const { Miniflare } = await import("miniflare");
  const { tickEveryMs = 5_000, ...stackOpts } = opts;
  const persist = mkdtempSync(join(tmpdir(), "hermesd-stack-"));
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: await bundleWorker() }],
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
  const timer = tickEveryMs > 0 ? setInterval(() => void actor("sweeper", "/ctl/cron", { name: "tick" }).catch(() => undefined), tickEveryMs) : undefined;

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
    rows: async (a, sql) => (await actor(a, "/ctl/rows", { sql })) as SqlRow[],
    evict: async (a) => void (await actor(a, "/ctl/abort")),
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
      if (timer) clearInterval(timer);
      await mf.dispose();
      rmSync(persist, { recursive: true, force: true });
    },
  };
}
