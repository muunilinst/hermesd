import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RpcClient } from "@hermesd/host";
import { CapabilityError, PlacementError, PluginHost } from "./host.ts";
import type { PluginContext } from "./host.ts";
import { HookRegistry, type HookDispatcher } from "./hooks.ts";
import { ManifestError } from "./manifest.ts";
import { diffValues, type Effects } from "./site.ts";
import { PluginState, STATE_CAP_BYTES, StateCapError } from "./state.ts";

const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;

/** A fake gateway host. It "runs" Python plugins: here, a table of handlers. */
class FakeGateway implements RpcClient {
  calls: { method: string; params: unknown }[] = [];
  hooks = new Map<string, (kwargs: Record<string, unknown>) => unknown>();
  async call<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });
    const p = params as Record<string, unknown>;
    if (method === "plugin.load") return { name: "py" } as T;
    if (method === "plugin.call_hook") {
      const fn = this.hooks.get(`${String(p["plugin"])}:${String(p["hook"])}`);
      if (!fn) throw new Error("no such python hook");
      return { result: fn(p["kwargs"] as Record<string, unknown>) } as T;
    }
    throw new Error(`unexpected ${method}`);
  }
}

async function pythonPluginDir(name: string, hooks: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "plugin-host-"));
  const dir = join(root, name);
  await mkdir(dir);
  await writeFile(join(dir, "plugin.yaml"), `name: ${name}\nversion: 1.0.0\nprovides_hooks: [${hooks.join(", ")}]\n`);
  await writeFile(join(dir, "__init__.py"), "def register(ctx):\n    pass\n");
  return dir;
}

test("fixtures: portable plugin and first-party JS plugin both load", async () => {
  const host = new PluginHost();
  const loaded = await host.loadAll(FIXTURES, "first-party");
  assert.deepEqual(loaded.map((p) => [p.dir, p.runtime]), [
    ["first-party-guard", "js"],
    ["portable-notes", "portable"],
  ]);
  const portable = host.plugins.get("portable-notes")!;
  assert.deepEqual(portable.skills, ["notes"]);
  assert.deepEqual(portable.manifest.capabilities, ["network"]);
  assert.deepEqual(portable.mcpServers, [{ name: "notes", transport: "http", url: "https://mcp.example.test/notes" }]);
  assert.match(portable.manifest.description ?? "", /^Note taking skills/);
  // The portable plugin registers no code.
  assert.deepEqual(await host.hooks.invoke("pre_tool_call", { tool_name: "ls", args: {} }), [
    { plugin: "guard", dir: "first-party-guard", hook: "pre_tool_call", value: { action: "approve" } },
  ]);
});

test("the loop can import the dispatcher interface", async () => {
  const host = new PluginHost();
  await host.load(join(FIXTURES, "first-party-guard"), "first-party");
  const dispatcher: HookDispatcher = host.hooks;
  assert.equal(await dispatcher.preLlmCall({ session_id: "s9" }), "guard: session s9 is watched");
  assert.equal((await dispatcher.preToolCall({ tool_name: "terminal", args: { command: "rm -rf /" } })).action, "block");
});

test("a third-party JS plugin is refused in the actor", async () => {
  const host = new PluginHost();
  await assert.rejects(host.load(join(FIXTURES, "first-party-guard"), "third-party"), PlacementError);
  // A portable plugin has no code, so trust does not matter.
  await host.load(join(FIXTURES, "portable-notes"), "third-party");
});

test("ctx is frozen; fetch fails closed without the network capability; undeclared hooks are refused", async () => {
  let ctxSeen: PluginContext | undefined;
  const host = new PluginHost({
    fetch: async () => new Response("ok"),
    importModule: async () => ({
      register(ctx: PluginContext) {
        ctxSeen = ctx;
        ctx.registerHook("post_tool_call", () => null);
      },
    }),
  });
  const dir = await mkdtemp(join(tmpdir(), "plugin-host-"));
  await writeFile(join(dir, "plugin.yaml"), "name: nocap\nruntime: js\nprovides_hooks: [post_tool_call]\n");
  await writeFile(join(dir, "index.js"), "");
  await host.load(dir, "first-party");
  assert.ok(Object.isFrozen(ctxSeen));
  assert.throws(() => {
    (ctxSeen as { pluginName: string }).pluginName = "x";
  }, TypeError);
  await assert.rejects(ctxSeen!.fetch("https://example.test"), CapabilityError);

  const dir2 = await mkdtemp(join(tmpdir(), "plugin-host-"));
  await writeFile(join(dir2, "plugin.yaml"), "name: withcap\nruntime: js\ncapabilities: [network]\n");
  await writeFile(join(dir2, "index.js"), "");
  const host2 = new PluginHost({
    fetch: async () => new Response("ok"),
    importModule: async () => ({
      register(ctx: PluginContext) {
        ctxSeen = ctx;
        ctx.registerHook("on_session_end", () => null); // not declared
      },
    }),
  });
  await assert.rejects(host2.load(dir2, "first-party"), ManifestError);
  assert.equal(host2.plugins.has("withcap"), false);
  const host3 = new PluginHost({
    fetch: async () => new Response("ok"),
    importModule: async () => ({ register: (ctx: PluginContext) => void (ctxSeen = ctx) }),
  });
  await host3.load(dir2, "first-party");
  assert.equal(await (await ctxSeen!.fetch("https://example.test")).text(), "ok");
});

test("ctx.state is capped at 10 MiB per plugin", () => {
  assert.equal(STATE_CAP_BYTES, 10 * 1024 * 1024);
  const s = new PluginState("p");
  s.set("a", "x".repeat(5 * 1024 * 1024));
  s.set("b", "y".repeat(4 * 1024 * 1024));
  const before = s.bytes;
  assert.throws(() => s.set("c", "z".repeat(2 * 1024 * 1024)), StateCapError);
  assert.equal(s.bytes, before, "a failed write changes nothing");
  assert.equal(s.has("c"), false);
  // Replacing a value counts only the difference.
  s.set("a", "small");
  s.set("c", "z".repeat(2 * 1024 * 1024));
  assert.ok(s.bytes <= STATE_CAP_BYTES);
  s.delete("c");
  assert.equal(s.bytes, Buffer.byteLength(JSON.stringify({ a: "small", b: "y".repeat(4 * 1024 * 1024) })));
  // Separate plugins have separate budgets.
  const other = new PluginState("q");
  other.set("a", "x".repeat(9 * 1024 * 1024));
  assert.throws(() => s.set("big", "x".repeat(STATE_CAP_BYTES)), StateCapError);
});

test("a Python plugin runs behind the fake gateway; the stub round trip is a placeholder", async (t) => {
  const gw = new FakeGateway();
  gw.hooks.set("py:pre_llm_call", (k) => `py saw ${String(k["session_id"])} and ${String(k["future_kwarg"])}`);
  gw.hooks.set("py:on_session_end", () => {
    throw new Error("python raised");
  });
  const dir = await pythonPluginDir("py", ["pre_llm_call", "on_session_end"]);
  const host = new PluginHost({ rpc: gw });
  const p = await host.load(dir, "third-party");
  assert.equal(p.runtime, "python");
  const kwargs = { session_id: "s1", future_kwarg: "new" };
  const t0 = performance.now();
  const text = await host.hooks.preLlmCall(kwargs);
  const ms = performance.now() - t0;
  assert.equal(text, "py saw s1 and new");
  assert.deepEqual(gw.calls.at(-1), {
    method: "plugin.call_hook",
    params: { plugin: "py", hook: "pre_llm_call", kwargs },
  });
  // A crash in Python is logged and skipped like any other crash.
  assert.deepEqual(await host.hooks.invoke("on_session_end", {}), []);
  t.diagnostic(`PLACEHOLDER fake-gateway round trip: ${ms.toFixed(3)} ms. Not a TeenyTiny or Cloudflare number.`);
});

test("a Python plugin needs a gateway sidecar", async () => {
  const dir = await pythonPluginDir("nogw", ["pre_llm_call"]);
  await assert.rejects(new PluginHost().load(dir, "third-party"), PlacementError);
});

test("python hook flag: ts port runs only in shadow or ts mode; python stays the answer in shadow", async () => {
  const gw = new FakeGateway();
  gw.hooks.set("py:pre_tool_call", () => ({ action: "block", message: "m", plugin: "py" }));
  const dir = await pythonPluginDir("py", ["pre_tool_call"]);
  const diffs: string[] = [];
  const host = new PluginHost({ rpc: gw, onDiff: (site) => diffs.push(site) });
  await host.load(dir, "third-party");
  // pure_hooks was not set, so the site is effectful: shadow records, never runs TS now.
  let tsRuns = 0;
  host.attachTsPort("hook", "py:pre_tool_call", async () => (tsRuns++, { action: "approve" }));
  host.flags.setMode("hook", "py:pre_tool_call", "shadow");
  assert.equal((await host.hooks.preToolCall({ tool_name: "x" })).action, "block");
  assert.equal(tsRuns, 0);
  assert.equal(host.recordings.length, 1);
  // Mark it pure and the TS port runs live; the difference is reported.
  host.flags.declare("hook", "py:pre_tool_call", { pure: true });
  assert.equal((await host.hooks.preToolCall({ tool_name: "x" })).action, "block");
  assert.equal(tsRuns, 1);
  assert.deepEqual(diffs, ["hook:py:pre_tool_call"]);
  // ts mode serves TypeScript.
  host.flags.setMode("hook", "py:pre_tool_call", "ts");
  assert.equal((await host.hooks.preToolCall({ tool_name: "x" })).action, "approve");
});

test("differential: JS pre_tool_call vs the recorded Python-side result", async () => {
  const host = new PluginHost();
  await host.load(join(FIXTURES, "first-party-guard"), "first-party");
  const fixture = JSON.parse(await readFile(join(FIXTURES, "python-side-pre_tool_call.json"), "utf8")) as {
    cases: { kwargs: Record<string, unknown>; python_result: unknown }[];
  };
  assert.ok(fixture.cases.length >= 4);
  for (const c of fixture.cases) {
    const js = await host.hooks.preToolCall(c.kwargs);
    assert.deepEqual(diffValues(c.python_result, js), [], JSON.stringify(c.kwargs));
  }
  // The comparator does see a real difference.
  const wrong = diffValues({ action: "approve" }, await host.hooks.preToolCall(fixture.cases[1]!.kwargs));
  assert.ok(wrong.length > 0);
});

test("the default real effects are forbidden", async () => {
  const gw = new FakeGateway();
  const dir = await pythonPluginDir("py", ["pre_tool_call"]);
  const host = new PluginHost({ rpc: gw });
  await host.load(dir, "third-party");
  let err: unknown;
  host.attachTsPort("hook", "py:pre_tool_call", async (_i, fx: Effects) => {
    try {
      await fx.call("send", 1);
    } catch (e) {
      err = e;
    }
    return null;
  });
  host.flags.setMode("hook", "py:pre_tool_call", "ts");
  await host.hooks.invoke("pre_tool_call", {});
  assert.match(String(err), /not allowed/);
  void HookRegistry;
});
