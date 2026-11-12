import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "@hermesd/host";
import { dist, percentile, runBench, validateOptions } from "./bench.ts";
import { FaultRules, Meter, MeteredHost } from "./meter.ts";
import type { StackFactory } from "./types.ts";

/** A clock the test moves by hand. */
function clock() {
  let t = 0;
  return { now: () => t, set: (x: number) => void (t = x) };
}

describe("Meter spans", () => {
  it("abandon ends open spans, and a late settle leaves the replacement's spans alone", async () => {
    const c = clock();
    const m = new Meter(c.now);
    m.reset();
    let never!: () => void;
    const dead = m.span(() => new Promise<void>((r) => (never = r)), true);
    c.set(10);
    m.abandon(); // the activation died with 10 ms open
    c.set(100);
    assert.equal(m.snapshot().busyMs, 10, "no time accrues after the abandon");
    let open!: () => void;
    const live = m.span(() => new Promise<void>((r) => (open = r)));
    c.set(110);
    never(); // the dead promise settles late
    await dead;
    c.set(120);
    open();
    await live;
    c.set(200);
    const s = m.snapshot();
    assert.equal(s.busyMs, 30, "10 ms before the crash, 20 ms of the new span");
    assert.equal(s.busyExclModelMs, 20, "the first 10 ms were a model wait");
  });

  it("records the first event of each activation", async () => {
    const m = new Meter(clock().now);
    m.reset();
    m.activated();
    await m.event(async () => {}, "call:receive:r1");
    await m.event(async () => {}, "alarm");
    m.activated();
    await m.event(async () => {}, "cron:tick");
    assert.deepEqual(m.snapshot().firstEvents, ["call:receive:r1", "cron:tick"]);
  });

  it("subtracts a model wait nested inside an event, as intervals", async () => {
    const c = clock();
    const m = new Meter(c.now);
    m.reset();
    await m.event(async () => {
      c.set(10); // 10 ms of work
      await m.span(async () => c.set(60), true); // 50 ms of model wait inside the event
      c.set(70); // 10 ms more
    });
    const s = m.snapshot();
    assert.equal(s.busyMs, 70);
    assert.equal(s.busyExclModelMs, 20);
  });

  it("counts overlapping model waits once", async () => {
    const c = clock();
    const m = new Meter(c.now);
    m.reset();
    const gate = () => {
      let open!: () => void;
      const p = new Promise<void>((r) => (open = r));
      return { p, open };
    };
    const ga = gate();
    const gb = gate();
    await m.event(async () => {
      const a = m.span(() => ga.p, true); // model wait 0..20
      c.set(10);
      const b = m.span(() => gb.p, true); // model wait 10..30
      c.set(20);
      ga.open();
      await a;
      c.set(30);
      gb.open();
      await b;
      c.set(40); // 10 ms of work after the waits
    });
    const s = m.snapshot();
    assert.equal(s.busyMs, 40);
    assert.equal(s.busyExclModelMs, 10, "the union of the two waits is 30 ms");
  });

  it("reads open spans at snapshot time and keeps counting after reset", async () => {
    const c = clock();
    const m = new Meter(c.now);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const open = m.event(() => gate);
    c.set(25);
    assert.equal(m.snapshot().busyMs, 25);
    m.reset();
    c.set(40);
    assert.equal(m.snapshot().busyMs, 15);
    release();
    await open;
  });
});

describe("MeteredHost", () => {
  it("times the call to inner.tx in busyMs", async () => {
    const c = clock();
    const meter = new Meter(c.now);
    meter.reset();
    const inner = {
      id: () => "a",
      epoch: () => 1,
      tx: async <T>(fn: (sql: { exec(): never[] }) => T): Promise<T> => {
        const r = fn({ exec: () => [] });
        c.set(c.now() + 30); // the adapter awaits its database
        return r;
      },
    } as unknown as Host;
    const host = new MeteredHost(inner, { actor: "s1", meter });
    await host.tx(() => 1);
    const s = meter.snapshot();
    assert.equal(s.tx, 1);
    assert.equal(s.busyMs, 30);
    assert.equal(s.busyExclModelMs, 30);
  });
});

describe("FaultRules.hit", () => {
  it("lets every matching rule count each event", () => {
    const r = new FaultRules();
    r.add({ actor: "s1", point: "commit:before", nth: 1 });
    r.add({ actor: "s1", point: "commit:before", nth: 2 });
    const fired = [1, 2, 3, 4].map(() => r.hit("s1", "commit:before"));
    // Like host-node: rule one acts on event 1, rule two on event 2.
    assert.deepEqual(fired, [true, true, false, false]);
  });

  it("matches the detail and the actor", () => {
    const r = new FaultRules();
    r.add({ actor: "s1", point: "sidecar:before", detail: "a.b" });
    assert.equal(r.hit("s1", "sidecar:before", "a.c"), false);
    assert.equal(r.hit("sweeper", "sidecar:before", "a.b"), false);
    assert.equal(r.hit("s1", "sidecar:before", "a.b"), true);
    assert.equal(r.hit("s1", "sidecar:before", "a.b"), false);
  });
});

describe("percentiles", () => {
  it("interpolate linearly, rank = q * (n - 1)", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(percentile(xs, 0.5), 10.5);
    assert.equal(percentile(xs, 0.95), 19.05);
    assert.deepEqual(dist([4, 1, 3, 2]), { median: 2.5, p95: 3.85, n: 4 });
    assert.deepEqual(dist([7]), { median: 7, p95: 7, n: 1 });
  });
  it("make an empty distribution explicit and refuse non-finite samples", () => {
    assert.deepEqual(dist([]), { n: 0, median: null, p95: null });
    assert.throws(() => dist([1, NaN]), /not finite/);
  });
});

describe("bench validation", () => {
  it("accepts the defaults and edge values", () => {
    assert.deepEqual(validateOptions({}), { turns: 20, toolEvery: 2, modelDelayMs: 0, coldSamples: 5 });
    assert.equal(validateOptions({ turns: 1, coldSamples: 0, toolEvery: 0, modelDelayMs: 0 }).coldSamples, 0);
  });
  it("rejects bad counts and delays before any stack starts", async () => {
    for (const bad of [{ turns: 0 }, { turns: 2.5 }, { turns: NaN }, { coldSamples: -1 }, { coldSamples: 1.5 }, { toolEvery: -1 }, { toolEvery: 0.5 }, { modelDelayMs: -1 }, { modelDelayMs: NaN }, { modelDelayMs: Infinity }]) {
      assert.throws(() => validateOptions(bad), /bench:/, JSON.stringify(bad));
      const make: StackFactory = async () => {
        throw new Error("a stack was started");
      };
      await assert.rejects(runBench(make, bad), /bench:/, JSON.stringify(bad));
    }
  });
});

describe("bench sample validity", () => {
  const tamper = (f: (r: import("./types.ts").StackReply) => import("./types.ts").StackReply): StackFactory => async (o) => {
    const { createNodeStack } = await import("./node.ts");
    const s = await createNodeStack(o);
    return { ...s, waitReplies: async (n, t) => (await s.waitReplies(n, t)).map(f) };
  };
  it("fails when a reply is not the scripted text", async () => {
    await assert.rejects(runBench(tamper((r) => ({ ...r, text: "oops" })), { turns: 2, coldSamples: 0 }), /scripted/);
  });
  it("fails when the reply kind is not a normal reply", async () => {
    await assert.rejects(runBench(tamper((r) => ({ ...r, kind: "error" })), { turns: 2, coldSamples: 0 }), /kind/);
  });
  it("fails when a cold sample did not wake an evicted actor", async () => {
    const make: StackFactory = async (o) => {
      const { createNodeStack } = await import("./node.ts");
      const s = await createNodeStack(o);
      return { ...s, evict: async () => {}, epochOf: async () => 1 };
    };
    await assert.rejects(runBench(make, { turns: 1, coldSamples: 1 }), /woken by something other than the timed send/);
  });
  it("rejects a cold sample that another event woke before the timed send", async () => {
    const make: StackFactory = async (o) => {
      const { createNodeStack } = await import("./node.ts");
      const s = await createNodeStack(o);
      // An event of s1 other than the timed receive wakes it first.
      return { ...s, evict: async (a) => { await s.evict(a); await s.call(a, "no_such_method").catch(() => {}); } };
    };
    await assert.rejects(runBench(make, { turns: 1, coldSamples: 1 }), /first event of the activation was/);
  });
  it("reports an empty cold distribution explicitly", async () => {
    const { createNodeStack } = await import("./node.ts");
    const r = await runBench((o) => createNodeStack(o), { turns: 2, coldSamples: 0 });
    assert.deepEqual(r.coldToModelMs, { n: 0, median: null, p95: null });
  });
});
