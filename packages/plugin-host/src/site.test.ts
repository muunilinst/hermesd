import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diffValues,
  FlagStore,
  forbiddenEffects,
  replayRecording,
  ReplayMissError,
  runSite,
  type Effects,
  type Recording,
  type SiteContext,
} from "./site.ts";

/** Counts real sends. Stands in for "send a message". */
function realSender() {
  const sent: unknown[] = [];
  const fx: Effects = {
    async call(_name, request) {
      sent.push(request);
      return { ok: true };
    },
  };
  return { sent, fx };
}

function ctxWith(flags: FlagStore, realEffects: Effects = forbiddenEffects): SiteContext {
  return { flags, realEffects, recordings: [] };
}

test("flags are data: round trip, safe defaults, pure only when marked", () => {
  const f = new FlagStore();
  assert.deepEqual(f.get("tool", "unknown"), { kind: "tool", name: "unknown", mode: "python", effect: "effectful" });
  f.declare("tool", "search", { pure: true });
  f.declare("hook", "p:pre_tool_call");
  f.declare("adapter", "telegram");
  f.setMode("tool", "search", "shadow");
  assert.equal(f.get("hook", "p:pre_tool_call").effect, "effectful");
  const copy = FlagStore.fromJSON(JSON.parse(JSON.stringify(f.toJSON())));
  assert.deepEqual(copy.toJSON(), f.toJSON());
  assert.equal(copy.get("tool", "search").mode, "shadow");
  // A re-declare keeps the mode.
  f.declare("tool", "search", { pure: true });
  assert.equal(f.get("tool", "search").mode, "shadow");
  // Anything that is not "pure" reads back as effectful.
  const odd = FlagStore.fromJSON([{ kind: "tool", name: "x", mode: "ts", effect: "maybe" }]);
  assert.equal(odd.get("tool", "x").effect, "effectful");
  assert.throws(() => FlagStore.fromJSON([{ kind: "tool", name: "x", mode: "bogus" }]), TypeError);
});

test("python mode runs Python only; ts mode runs TS only with the real effects", async () => {
  const flags = new FlagStore();
  flags.declare("tool", "t");
  const { sent, fx } = realSender();
  let tsRuns = 0;
  let pyRuns = 0;
  const impls = {
    python: async () => (pyRuns++, { result: "py", calls: [] }),
    ts: async (_i: string, e: Effects) => (tsRuns++, await e.call("send", "msg"), "ts"),
  };
  const ctx = ctxWith(flags, fx);
  assert.equal((await runSite("tool", "t", "in", impls, ctx)).result, "py");
  assert.deepEqual([pyRuns, tsRuns, sent.length], [1, 0, 0]);
  flags.setMode("tool", "t", "ts");
  const r = await runSite("tool", "t", "in", impls, ctx);
  assert.deepEqual([r.served, r.result, pyRuns, tsRuns, sent.length], ["ts", "ts", 1, 1, 1]);
});

test("live shadow on a pure site: both run, Python answers, diffs are reported", async () => {
  const flags = new FlagStore();
  flags.declare("tool", "search", { pure: true });
  flags.setMode("tool", "search", "shadow");
  const seen: string[] = [];
  const ctx: SiteContext = { ...ctxWith(flags), onDiff: (site) => seen.push(site) };
  const same = await runSite("tool", "search", "q", { python: async () => ({ result: { a: 1 }, calls: [] }), ts: async () => ({ a: 1 }) }, ctx);
  assert.deepEqual(same.diffs, []);
  const differ = await runSite("tool", "search", "q", { python: async () => ({ result: { a: 1 }, calls: [] }), ts: async () => ({ a: 2 }) }, ctx);
  assert.equal(differ.served, "python");
  assert.deepEqual(differ.result, { a: 1 });
  assert.deepEqual(differ.diffs, [{ path: ".a", python: 1, ts: 2 }]);
  assert.deepEqual(seen, ["tool:search"]);
  // A pure site that tries an effect is caught as a diff, and Python still answers.
  const bad = await runSite(
    "tool",
    "search",
    "q",
    { python: async () => ({ result: 1, calls: [] }), ts: async (_i, fx) => (await fx.call("send", 1), 1) },
    ctx,
  );
  assert.equal(bad.result, 1);
  assert.equal(bad.diffs[0]?.path, "$thrown");
});

test("replay shadow: shadow on an effectful site never runs the TS effect live", async () => {
  const flags = new FlagStore();
  flags.declare("tool", "send_message"); // unmarked: effectful
  flags.setMode("tool", "send_message", "shadow");
  const real = realSender();
  const ctx = ctxWith(flags, real.fx);
  let tsRuns = 0;
  const tsImpl = async (input: { text: string }, fx: Effects) => {
    tsRuns++;
    await fx.call("telegram.send", { text: input.text, chat: 7 });
    return "sent";
  };
  // The Python side did the one real effect. It reports it.
  const python = async (input: { text: string }) => {
    real.sent.push({ text: input.text, chat: 7 });
    return { result: "sent", calls: [{ name: "telegram.send", request: { text: input.text, chat: 7 }, response: { id: 1 } }] };
  };
  const run = await runSite("tool", "send_message", { text: "hi" }, { python, ts: tsImpl }, ctx);
  assert.equal(run.recorded, true);
  assert.equal(run.served, "python");
  assert.equal(tsRuns, 0, "TS did not run during live traffic");
  assert.equal(real.sent.length, 1, "exactly one real effect");

  // Later: replay against mocks. Still exactly one real effect in total.
  const report = await replayRecording(ctx.recordings[0]! as Recording<{ text: string }, string>, tsImpl);
  assert.equal(tsRuns, 1);
  assert.equal(real.sent.length, 1, "replay sent nothing");
  assert.deepEqual(report.diffs, []);
  assert.deepEqual(report.resultDiffs, []);
});

test("replay shadow compares requests: a different TS request is a diff", async () => {
  const flags = new FlagStore();
  flags.declare("tool", "post");
  flags.setMode("tool", "post", "shadow");
  const ctx = ctxWith(flags);
  await runSite(
    "tool",
    "post",
    { n: 1 },
    { python: async () => ({ result: "ok", calls: [{ name: "http", request: { url: "/a", n: 1 }, response: 200 }] }), ts: async () => "ok" },
    ctx,
  );
  const report = await replayRecording(ctx.recordings[0]! as Recording<{ n: number }, string>, async (i, fx) => {
    await fx.call("http", { url: "/b", n: i.n });
    return "ok";
  });
  assert.equal(report.diffs.length, 1);
  assert.equal(report.diffs[0]?.path, "[0].request.url");
  // An extra TS call has no recorded response.
  const extra = await replayRecording(ctx.recordings[0]!, async (_i, fx) => {
    await fx.call("http", {});
    await fx.call("http", {});
    return "ok";
  });
  assert.equal(extra.resultDiffs[0]?.path, "$thrown");
  assert.ok(extra.resultDiffs[0]?.ts !== undefined);
  assert.ok(new ReplayMissError("x", 1).message.includes("no recorded response"));
});

test("diffValues finds changes in objects and arrays", () => {
  assert.deepEqual(diffValues({ a: [1, 2] }, { a: [1, 2] }), []);
  assert.deepEqual(diffValues({ a: [1, 2] }, { a: [1, 3] }).map((d) => d.path), [".a[1]"]);
  assert.deepEqual(diffValues({ a: 1 }, { b: 1 }).map((d) => d.path).sort(), [".a", ".b"]);
  assert.equal(diffValues([], {}).length, 1);
});
