/**
 * The plugin host. It loads plugin directories and runs plugin code in one of
 * three places:
 *  - portable: no code. Only skills and MCP config (HTTP MCP servers).
 *  - js: a first-party JS module with `register(ctx)`, in the actor.
 *  - python: the gateway host, over JSON-RPC (see python-rpc.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RpcClient } from "@hermesd/host";
import { HookRegistry, type HookKwargs, type HookRegistryOptions } from "./hooks.ts";
import { classifyPlugin, ManifestError, parseManifest, type PluginManifest, type PluginRuntime } from "./manifest.ts";
import { PythonPluginClient } from "./python-rpc.ts";
import {
  FlagStore,
  forbiddenEffects,
  runSite,
  type Effects,
  type Recording,
  type SiteContext,
  type Diff,
} from "./site.ts";
import { PluginState, STATE_CAP_BYTES } from "./state.ts";

export type Trust = "first-party" | "third-party";

export class PlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementError";
  }
}

export class CapabilityError extends Error {
  constructor(plugin: string, capability: string) {
    super(`plugin ${plugin} did not declare the "${capability}" capability`);
    this.name = "CapabilityError";
  }
}

export interface LoadedPlugin {
  /** Directory name. Join order uses it. */
  dir: string;
  path: string;
  manifest: PluginManifest;
  runtime: PluginRuntime;
  trust: Trust;
  state: PluginState;
  /** Skill folder names (portable plugins and others). */
  skills: string[];
  /** HTTP MCP servers from the `mcp_servers` manifest key, as read. */
  mcpServers: unknown;
}

/** The API a JS plugin sees. It is frozen. */
export interface PluginContext {
  readonly pluginName: string;
  readonly capabilities: readonly string[];
  readonly state: PluginState;
  registerHook(name: string, callback: (kwargs: HookKwargs, signal: AbortSignal) => unknown): void;
  registerTool(
    name: string,
    toolset: string,
    schema: unknown,
    handler: (args: unknown, signal: AbortSignal) => unknown,
  ): void;
  /** Needs the "network" capability. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  log(message: string): void;
}

export interface PluginHostOptions extends HookRegistryOptions {
  /** The gateway sidecar, from `Host.sidecar("gateway")`. Needed for python plugins. */
  rpc?: RpcClient;
  flags?: FlagStore;
  /** The real effects used when a site is served by TypeScript. */
  realEffects?: Effects;
  /** Outbound HTTP for plugins with the "network" capability. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  importModule?: (path: string) => Promise<unknown>;
  stateCapBytes?: number;
  onDiff?: (site: string, diffs: Diff[]) => void;
}

type TsPort = (input: never, fx: Effects) => Promise<unknown>;

interface ToolReg {
  plugin: string;
  run(args: unknown, signal: AbortSignal): Promise<unknown>;
}

const ENTRY_FILES = ["index.js", "index.mjs", "index.ts"];

export class PluginHost {
  readonly hooks: HookRegistry;
  readonly flags: FlagStore;
  readonly recordings: Recording[] = [];
  readonly plugins = new Map<string, LoadedPlugin>();
  readonly #tools = new Map<string, ToolReg>();
  readonly #tsPorts = new Map<string, TsPort>();
  readonly #opts: PluginHostOptions;
  readonly #siteCtx: SiteContext;
  readonly #python: PythonPluginClient | undefined;

  constructor(opts: PluginHostOptions = {}) {
    this.#opts = opts;
    this.hooks = new HookRegistry(opts);
    this.flags = opts.flags ?? new FlagStore();
    this.#python = opts.rpc ? new PythonPluginClient(opts.rpc) : undefined;
    this.#siteCtx = {
      flags: this.flags,
      realEffects: opts.realEffects ?? forbiddenEffects,
      recordings: this.recordings,
      ...(opts.onDiff ? { onDiff: opts.onDiff } : {}),
    };
  }

  /** Load every plugin directory under `root`, in alphabetical order. */
  async loadAll(root: string, trust: Trust): Promise<LoadedPlugin[]> {
    const names = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const out: LoadedPlugin[] = [];
    for (const n of names) out.push(await this.load(join(root, n), trust));
    return out;
  }

  /**
   * Load one plugin directory. A third-party plugin never runs as JS in the
   * actor (guide section 6.6): that throws `PlacementError`.
   */
  async load(path: string, trust: Trust): Promise<LoadedPlugin> {
    const manifest = parseManifest(await readFile(join(path, "plugin.yaml"), "utf8"));
    const entries = await readdir(path, { recursive: true });
    const runtime = classifyPlugin(manifest, entries);
    if (this.plugins.has(manifest.name)) throw new ManifestError(`plugin ${manifest.name} is already loaded`);
    if (runtime === "js" && trust !== "first-party") {
      throw new PlacementError(
        `plugin ${manifest.name} is third-party JS. It must run in a sandbox, not in the actor.`,
      );
    }
    const skillDirs = await readdir(join(path, "skills"), { withFileTypes: true }).catch(() => []);
    const plugin: LoadedPlugin = {
      dir: basename(path),
      path,
      manifest,
      runtime,
      trust,
      state: new PluginState(manifest.name, this.#opts.stateCapBytes ?? STATE_CAP_BYTES),
      skills: skillDirs.filter((d) => d.isDirectory()).map((d) => d.name).sort(),
      mcpServers: manifest.extra["mcp_servers"] ?? null,
    };
    for (const h of manifest.providesHooks) this.flags.declare("hook", `${manifest.name}:${h}`, { pure: manifest.pureHooks.includes(h) });
    for (const t of manifest.providesTools) this.flags.declare("tool", t, { pure: manifest.pureTools.includes(t) });

    if (runtime === "js") await this.#loadJs(plugin, entries);
    else if (runtime === "python") await this.#loadPython(plugin);
    this.plugins.set(manifest.name, plugin);
    return plugin;
  }

  async #loadJs(plugin: LoadedPlugin, entries: string[]): Promise<void> {
    const entry = ENTRY_FILES.find((f) => entries.includes(f));
    if (!entry) throw new ManifestError(`plugin ${plugin.manifest.name} has no ${ENTRY_FILES.join(" or ")}`);
    const url = pathToFileURL(join(plugin.path, entry)).href;
    const mod = (await (this.#opts.importModule ?? ((u: string) => import(u)))(url)) as {
      register?: (ctx: PluginContext) => unknown;
      default?: { register?: (ctx: PluginContext) => unknown };
    };
    const register = mod.register ?? mod.default?.register;
    if (typeof register !== "function") throw new ManifestError(`plugin ${plugin.manifest.name} has no register(ctx)`);
    try {
      await register(this.#makeContext(plugin));
    } catch (err) {
      // A plugin that fails in register() leaves nothing behind.
      this.hooks.unregister(plugin.manifest.name);
      for (const [k, v] of this.#tools) if (v.plugin === plugin.manifest.name) this.#tools.delete(k);
      throw err;
    }
  }

  #makeContext(plugin: LoadedPlugin): PluginContext {
    const m = plugin.manifest;
    const caps = Object.freeze([...m.capabilities]);
    const doFetch = this.#opts.fetch ?? ((i: string | URL | Request, init?: RequestInit) => fetch(i, init));
    const ctx: PluginContext = {
      pluginName: m.name,
      capabilities: caps,
      state: plugin.state,
      registerHook: (name, callback) => {
        // Fail closed: a hook the manifest does not declare is refused.
        if (!m.providesHooks.includes(name)) {
          throw new ManifestError(`plugin ${m.name} registered "${name}" but provides_hooks does not list it`);
        }
        this.hooks.register({ plugin: m.name, dir: plugin.dir, hook: name, run: callback });
      },
      registerTool: (name, _toolset, _schema, handler) => {
        if (!m.providesTools.includes(name)) {
          throw new ManifestError(`plugin ${m.name} registered tool "${name}" but provides_tools does not list it`);
        }
        this.#tools.set(name, { plugin: m.name, run: async (args, signal) => handler(args, signal) });
      },
      fetch: (input, init) => {
        if (!caps.includes("network")) return Promise.reject(new CapabilityError(m.name, "network"));
        return doFetch(input, init);
      },
      log: () => {},
    };
    return Object.freeze(ctx);
  }

  async #loadPython(plugin: LoadedPlugin): Promise<void> {
    const py = this.#python;
    if (!py) throw new PlacementError(`plugin ${plugin.manifest.name} is Python and no gateway sidecar is set`);
    await py.load(plugin.path);
    const m = plugin.manifest;
    for (const hook of m.providesHooks) {
      const site = `${m.name}:${hook}`;
      this.hooks.register({
        plugin: m.name,
        dir: plugin.dir,
        hook,
        run: async (kwargs, signal) => {
          const port = this.#tsPorts.get(`hook:${site}`);
          const run = await runSite(
            "hook",
            site,
            kwargs,
            {
              python: (input, s) => py.callHook(m.name, hook, input, s),
              ts: (input, fx) => (port ? port(input as never, fx) : Promise.reject(new Error(`no TS port for ${site}`))),
            },
            this.#effectiveCtx(port !== undefined),
            signal,
          );
          return run.result;
        },
      });
    }
    for (const tool of m.providesTools) {
      this.#tools.set(tool, {
        plugin: m.name,
        run: async (args, signal) => {
          const port = this.#tsPorts.get(`tool:${tool}`);
          const run = await runSite(
            "tool",
            tool,
            args,
            {
              python: (input, s) => py.callTool(m.name, tool, input, s),
              ts: (input, fx) => (port ? port(input as never, fx) : Promise.reject(new Error(`no TS port for ${tool}`))),
            },
            this.#effectiveCtx(port !== undefined),
            signal,
          );
          return run.result;
        },
      });
    }
  }

  /** Without a TS port, a site cannot leave python. Keep Python as the answer. */
  #effectiveCtx(hasPort: boolean): SiteContext {
    if (hasPort) return this.#siteCtx;
    return { ...this.#siteCtx, flags: new FlagStore() };
  }

  /**
   * Attach the TypeScript version of a Python hook or tool. It only runs if the
   * site's flag says shadow or ts. For hooks, the site name is "plugin:hook".
   */
  attachTsPort<I>(kind: "hook" | "tool", name: string, port: (input: I, fx: Effects) => Promise<unknown>): void {
    this.#tsPorts.set(`${kind}:${name}`, port as TsPort);
  }

  hasTool(name: string): boolean {
    return this.#tools.has(name);
  }

  async callTool(name: string, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
    const t = this.#tools.get(name);
    if (!t) throw new Error(`no such plugin tool: ${name}`);
    return t.run(args, signal);
  }
}
