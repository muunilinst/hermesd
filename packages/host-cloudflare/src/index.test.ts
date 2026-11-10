/** Unit tests with a fake `ctx`. The fake keeps its rows in `node:sqlite`. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { CloudflareHost, SidecarError } from "./index.ts";
import type { StateLike } from "./index.ts";

interface Fake extends StateLike {
  log: string[];
  alarm: number | null;
}

/** A fake that records the order of the durable calls in `log`. */
function fakeCtx(db = new DatabaseSync(":memory:")): Fake {
  const f: Fake = {
    log: [],
    alarm: null,
    id: { name: "sess-1", toString: () => "hex" },
    storage: {
      sql: {
        exec(q: string, ...b: unknown[]) {
          const stmt = db.prepare(q);
          const rows = /^\s*(select|with)/i.test(q) ? stmt.all(...(b as never[])) : (stmt.run(...(b as never[])), []);
          return { toArray: () => rows as Record<string, unknown>[] };
        },
      },
      transactionSync<T>(fn: () => T): T {
        db.exec("BEGIN");
        try {
          const r = fn();
          db.exec("COMMIT");
          return r;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      async sync() {
        f.log.push("sync");
      },
      async setAlarm(t: number | Date) {
        f.alarm = typeof t === "number" ? t : t.getTime();
        f.log.push(`setAlarm:${f.alarm}`);
      },
      async getAlarm() {
        return f.alarm;
      },
      async deleteAlarm() {
        f.alarm = null;
        f.log.push("deleteAlarm");
      },
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  return f;
}

describe("CloudflareHost with a fake ctx", () => {
  it("raises the epoch once per activation, and syncs it", async () => {
    const db = new DatabaseSync(":memory:");
    const c1 = fakeCtx(db);
    const h1 = new CloudflareHost(c1);
    await h1.ready;
    assert.equal(h1.epoch(), 1);
    assert.deepEqual(c1.log, ["sync"]);
    const h2 = new CloudflareHost(fakeCtx(db));
    await h2.ready;
    assert.equal(h2.epoch(), 2);
    assert.equal(h2.id(), "sess-1");
  });

  it("epoch() throws before activation", () => {
    const ctx = fakeCtx();
    ctx.blockConcurrencyWhile = () => new Promise(() => {});
    assert.throws(() => new CloudflareHost(ctx).epoch(), /before activation/);
  });

  it("tx commits, rolls back on throw, and refuses a promise", async () => {
    const h = new CloudflareHost(fakeCtx());
    await h.ready;
    await h.tx((s) => s.exec("CREATE TABLE t (v TEXT)"));
    await h.tx((s) => s.exec("INSERT INTO t VALUES ('a')"));
    await assert.rejects(
      h.tx((s) => {
        s.exec("INSERT INTO t VALUES ('b')");
        throw new Error("boom");
      }),
      /boom/,
    );
    await assert.rejects(h.tx(async (s) => s.exec("INSERT INTO t VALUES ('c')")), TypeError);
    assert.deepEqual(await h.tx((s) => s.exec("SELECT v FROM t")), [{ v: "a" }]);
  });

  it("commit waits for sync", async () => {
    const ctx = fakeCtx();
    const h = new CloudflareHost(ctx);
    await h.ready;
    ctx.log.length = 0;
    await h.commit();
    assert.deepEqual(ctx.log, ["sync"]);
  });

  it("arm sets the alarm to the earliest time, then syncs", async () => {
    const ctx = fakeCtx();
    const h = new CloudflareHost(ctx);
    await h.ready;
    ctx.log.length = 0;
    await h.arm(new Date(5000), "a");
    await h.arm(new Date(2000), "b");
    await h.arm(new Date(9000), "c");
    assert.deepEqual(ctx.log, ["setAlarm:5000", "sync", "setAlarm:2000", "sync", "setAlarm:2000", "sync"]);
    await h.arm(new Date(7000), "b");
    assert.equal(ctx.alarm, 5000, "moving the earliest obligation later picks the next one");
  });

  it("handleAlarm re-arms first, then calls the handler; due rows stay until disarm", async () => {
    let now = 1000;
    const ctx = fakeCtx();
    const h = new CloudflareHost(ctx, { now: () => now, retryDelayMs: 100 });
    await h.ready;
    await h.arm(new Date(1000), "due");
    await h.arm(new Date(5000), "future");
    ctx.log.length = 0;
    const order: string[] = [];
    h.onAlarm(async (keys) => {
      order.push(`handler:${keys.join(",")}:alarm=${ctx.alarm}`);
    });
    const due = await h.handleAlarm();
    assert.deepEqual(due, ["due"]);
    assert.deepEqual(order, ["handler:due:alarm=1100"], "alarm was set before the handler ran");
    now = 1100;
    await h.disarm("due");
    assert.equal(ctx.alarm, 5000);
  });

  it("handleAlarm with no due row is an early alarm: it re-arms and does not call the handler", async () => {
    const ctx = fakeCtx();
    const h = new CloudflareHost(ctx, { now: () => 1000 });
    await h.ready;
    await h.arm(new Date(4000), "x");
    let called = false;
    h.onAlarm(async () => {
      called = true;
    });
    assert.deepEqual(await h.handleAlarm(), []);
    assert.equal(called, false);
    assert.equal(ctx.alarm, 4000);
  });

  it("disarm of the last obligation deletes the alarm", async () => {
    const ctx = fakeCtx();
    const h = new CloudflareHost(ctx);
    await h.ready;
    await h.arm(new Date(4000), "x");
    await h.disarm("x");
    assert.equal(ctx.alarm, null);
  });

  it("fetch passes the abort signal and throws if already aborted", async () => {
    let seen: AbortSignal | undefined;
    const h = new CloudflareHost(fakeCtx(), {
      fetch: async (r) => {
        seen = r.signal;
        return new Response("ok");
      },
    });
    await h.ready;
    const ac = new AbortController();
    await h.fetch(new Request("http://x/"), ac.signal);
    assert.equal(seen?.aborted, false);
    ac.abort();
    assert.equal(seen?.aborted, true);
    await assert.rejects(h.fetch(new Request("http://x/"), ac.signal));
  });

  it("sidecar sends the epoch and maps errors", async () => {
    const h = new CloudflareHost(fakeCtx(), {
      sidecars: {
        executor: {
          async fetch(req) {
            if (req.headers.get("x-hermesd-epoch") !== "1") return new Response("stale", { status: 409 });
            const body = (await req.json()) as { method: string; params: { n: number } };
            if (body.method === "bad") return new Response("nope", { status: 500 });
            return Response.json({ n: body.params.n + 1 });
          },
        },
      },
    });
    await h.ready;
    assert.deepEqual(await h.sidecar("executor").call("inc", { n: 1 }), { n: 2 });
    await assert.rejects(h.sidecar("executor").call("bad", {}), SidecarError);
    await assert.rejects(h.sidecar("gateway").call("x", {}), /no sidecar binding/);
  });
});
