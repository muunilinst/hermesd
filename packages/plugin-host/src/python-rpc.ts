/**
 * Client stub for Python plugins. The Python code runs in the gateway host.
 * This side only sends JSON-RPC calls over `Host.sidecar("gateway")`.
 *
 * Methods (the gateway host must serve them):
 *   plugin.load       {dir}                         -> {name}
 *   plugin.call_hook  {plugin, hook, kwargs}        -> {result, calls?}
 *   plugin.call_tool  {plugin, tool, args}          -> {result, calls?}
 *
 * `calls` lists the outbound calls that the Python side made. Replay shadow
 * needs them. A reply without `calls` means "none that were recorded".
 */
import type { RpcClient } from "@hermesd/host";
import type { EffectCall, PythonOutcome } from "./site.ts";

interface Reply {
  result?: unknown;
  calls?: EffectCall[];
}

export class PythonPluginClient {
  readonly #rpc: RpcClient;

  constructor(rpc: RpcClient) {
    this.#rpc = rpc;
  }

  async load(dir: string, signal?: AbortSignal): Promise<{ name: string }> {
    return this.#rpc.call<{ name: string }>("plugin.load", { dir }, signal);
  }

  async callHook(plugin: string, hook: string, kwargs: unknown, signal?: AbortSignal): Promise<PythonOutcome<unknown>> {
    const r = await this.#rpc.call<Reply>("plugin.call_hook", { plugin, hook, kwargs }, signal);
    return { result: r?.result ?? null, calls: r?.calls ?? [] };
  }

  async callTool(plugin: string, tool: string, args: unknown, signal?: AbortSignal): Promise<PythonOutcome<unknown>> {
    const r = await this.#rpc.call<Reply>("plugin.call_tool", { plugin, tool, args }, signal);
    return { result: r?.result ?? null, calls: r?.calls ?? [] };
  }
}
