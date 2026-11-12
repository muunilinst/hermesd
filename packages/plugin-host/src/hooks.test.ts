import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HookRegistry,
  knownHookNames,
  UnknownHookError,
  type HookLogEntry,
  type Timers,
} from "./hooks.ts";

/** A clock the test moves by hand. */
class VirtualClock implements Timers {
  now = 0;
  #timers: { at: number; fn: () => void; live: boolean }[] = [];
  after(ms: number, fn: () => void): () => void {
    const t = { at: this.now + ms, fn, live: true };
    this.#timers.push(t);
    return () => {
      t.live = false;
    };
  }
  advance(ms: number): void {
    this.now += ms;
    for (const t of this.#timers) {
      if (t.live && t.at <= this.now) {
        t.live = false;
        t.fn();
      }
    }
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test("known hooks: the list in the registry is the contracts file", () => {
  const file = JSON.parse(
    readFileSync(new URL("../../../contracts/known-hooks.json", import.meta.url), "utf8"),
  ) as { hooks: string[] };
  assert.deepEqual([...knownHookNames()].sort(), [...file.hooks].sort());
  assert.ok(file.hooks.length >= 46);
});

test("every known hook name dispatches, and an unknown name fails", async () => {
  const reg = new HookRegistry();
  const seen: string[] = [];
  for (const h of knownHookNames()) reg.register({ plugin: "p", dir: "p", hook: h, run: () => (seen.push(h), h) });
  for (const h of knownHookNames()) {
    const out = await reg.invoke(h, { x: 1 });
    assert.deepEqual(out.map((e) => e.value), [h]);
  }
  assert.equal(seen.length, knownHookNames().size);
  await assert.rejects(reg.invoke("not_a_real_hook", {}), UnknownHookError);
  assert.throws(() => reg.register({ plugin: "p", dir: "p", hook: "not_a_real_hook", run: () => 0 }), UnknownHookError);
});

test("keyword arguments pass through unchanged, including new ones", async () => {
  const reg = new HookRegistry();
  let got: unknown;
  reg.register({ plugin: "p", dir: "p", hook: "post_tool_call", run: (k) => ((got = k), null) });
  const kwargs = { tool_name: "t", brand_new_upstream_kwarg: { deep: [1, 2] }, "odd key": undefined };
  await reg.invoke("post_tool_call", kwargs);
  assert.deepEqual(got, kwargs);
  assert.ok("brand_new_upstream_kwarg" in (got as object));
});

test("a callback that throws is logged and skipped; the others still run", async () => {
  const log: HookLogEntry[] = [];
  const reg = new HookRegistry({ log: (e) => log.push(e) });
  reg.register({ plugin: "a", dir: "a", hook: "on_session_end", run: () => { throw new Error("boom"); } });
  reg.register({ plugin: "b", dir: "b", hook: "on_session_end", run: async () => { throw new Error("async boom"); } });
  reg.register({ plugin: "c", dir: "c", hook: "on_session_end", run: () => "ok" });
  const out = await reg.invoke("on_session_end", {});
  assert.deepEqual(out.map((e) => e.value), ["ok"]);
  assert.deepEqual(log.map((e) => [e.kind, e.plugin]), [["error", "a"], ["error", "b"]]);
});

test("a callback past the time budget is logged, aborted and skipped (virtual clock)", async () => {
  const clock = new VirtualClock();
  const log: HookLogEntry[] = [];
  const reg = new HookRegistry({ timers: clock, log: (e) => log.push(e) });
  assert.equal(reg.timeoutMs, 30_000);
  let aborted = false;
  reg.register({
    plugin: "slow",
    dir: "a-slow",
    hook: "post_llm_call",
    run: (_k, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; });
        void resolve; // never resolves
      }),
  });
  reg.register({ plugin: "fast", dir: "b-fast", hook: "post_llm_call", run: () => "fast" });
  const p = reg.invoke("post_llm_call", {});
  await tick();
  clock.advance(29_999);
  await tick();
  assert.equal(log.length, 0, "not yet over budget");
  clock.advance(1);
  const out = await p;
  assert.equal(aborted, true);
  assert.deepEqual(out.map((e) => e.value), ["fast"]);
  assert.equal(log[0]?.kind, "timeout");
  assert.equal(log[0]?.plugin, "slow");
});

test("the time budget is configurable", async () => {
  const clock = new VirtualClock();
  const reg = new HookRegistry({ timers: clock, timeoutMs: 50 });
  reg.register({ plugin: "s", dir: "s", hook: "on_session_start", run: () => new Promise(() => {}) });
  const p = reg.invoke("on_session_start", {});
  await tick();
  clock.advance(50);
  assert.deepEqual(await p, []);
});

test("pre_llm_call outputs are joined in alphabetical order by plugin directory", async () => {
  const reg = new HookRegistry();
  // Registered out of order on purpose. The plugin name differs from the directory.
  reg.register({ plugin: "zeta-name", dir: "10-first", hook: "pre_llm_call", run: () => "one" });
  reg.register({ plugin: "alpha-name", dir: "b-second", hook: "pre_llm_call", run: () => ({ context: "two" }) });
  reg.register({ plugin: "mid", dir: "a-zero", hook: "pre_llm_call", run: () => "zero" });
  reg.register({ plugin: "none", dir: "c", hook: "pre_llm_call", run: () => null });
  reg.register({ plugin: "other", dir: "d", hook: "pre_llm_call", run: () => 42 });
  assert.equal(await reg.preLlmCall({}), "one\n\nzero\n\ntwo");
  assert.equal(await new HookRegistry().preLlmCall({}), null);
});

test("pre_tool_call: the first block wins, in directory order", async () => {
  const reg = new HookRegistry();
  reg.register({ plugin: "p2", dir: "b", hook: "pre_tool_call", run: () => ({ action: "block", message: "second" }) });
  reg.register({ plugin: "p1", dir: "a", hook: "pre_tool_call", run: () => ({ action: "block", message: "first" }) });
  reg.register({ plugin: "p0", dir: "0", hook: "pre_tool_call", run: () => ({ action: "approve" }) });
  assert.deepEqual(await reg.preToolCall({ tool_name: "x" }), { action: "block", message: "first", plugin: "p1" });
});

test("pre_tool_call: approve, unknown actions and a block with no message do not block", async () => {
  const reg = new HookRegistry();
  reg.register({ plugin: "a", dir: "a", hook: "pre_tool_call", run: () => ({ action: "approve" }) });
  reg.register({ plugin: "b", dir: "b", hook: "pre_tool_call", run: () => ({ action: "something_new" }) });
  reg.register({ plugin: "c", dir: "c", hook: "pre_tool_call", run: () => ({ action: "block" }) });
  reg.register({ plugin: "d", dir: "d", hook: "pre_tool_call", run: () => ({ action: "block", message: "" }) });
  reg.register({ plugin: "e", dir: "e", hook: "pre_tool_call", run: () => undefined });
  assert.deepEqual(await reg.preToolCall({}), { action: "approve" });
});

test("pre_tool_call fails closed: a crash and a timeout block the tool (upstream rule)", async () => {
  const crash = new HookRegistry();
  function guard(): never {
    const e = new Error("x".repeat(300));
    e.name = "RuntimeError";
    throw e;
  }
  crash.register({ plugin: "c", dir: "c", hook: "pre_tool_call", run: guard });
  const d = await crash.preToolCall({});
  assert.equal(d.action, "block");
  assert.equal(d.action === "block" && d.message, `pre_tool_call plugin callback guard raised RuntimeError: ${"x".repeat(200)}`);

  const clock = new VirtualClock();
  const slow = new HookRegistry({ timers: clock, timeoutMs: 10 });
  slow.register({ plugin: "s", dir: "s", hook: "pre_tool_call", run: () => new Promise(() => {}) });
  const p = slow.preToolCall({});
  await tick();
  clock.advance(10);
  assert.deepEqual(await p, { action: "block", message: "pre_tool_call plugin callback timed out or is still running", plugin: "s" });

  // Other hooks stay fail-open.
  const open = new HookRegistry();
  open.register({ plugin: "o", dir: "o", hook: "post_tool_call", run: guard });
  assert.deepEqual(await open.invoke("post_tool_call", {}), []);
});
