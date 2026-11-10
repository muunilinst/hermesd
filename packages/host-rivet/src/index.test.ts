/** Unit tests with a fake actor context (no rivetkit). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { FencedError, RivetHost, SidecarError, type ActorLike, type DbLike } from "./index.ts";

function fakeDb(raw = new DatabaseSync(":memory:")): DbLike {
  const db: DbLike = {
    execute: async (q, ...a) => raw.prepare(q).all(...(a as never[])).map((r) => ({ ...r })),
    transaction: async (cb) => {
      raw.exec("BEGIN");
      try {
        const r = await cb(db);
        raw.exec("COMMIT");
        return r;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return db;
}

function fakeActor(db = fakeDb(), id = "a1") {
  const scheduled: { at: number; action: string; args: unknown[]; id: string }[] = [];
  const cancelled: string[] = [];
  let kept = 0;
  const c: ActorLike = {
    actorId: id,
    key: ["k"],
    db,
    schedule: {
      at: async (at, action, ...args) => {
        const sid = `s${scheduled.length + 1}`;
        scheduled.push({ at, action, args, id: sid });
        return sid;
      },
      cancel: async (sid) => (cancelled.push(sid), true),
    },
    keepAwake: (p) => (kept++, p),
    abortSignal: new AbortController().signal,
  };
  return { c, scheduled, cancelled, kept: () => kept, db };
}

describe("RivetHost with a fake context", () => {
  it("raises the epoch at each activation", async () => {
    const f = fakeActor();
    assert.equal((await RivetHost.activate(f.c)).epoch(), 1);
    assert.equal((await RivetHost.activate(f.c)).epoch(), 2);
  });

  it("tx rolls back on throw and is durable on success", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    await h.tx((s) => s.exec("CREATE TABLE t (n INTEGER)"));
    await h.tx((s) => s.exec("INSERT INTO t VALUES (1)"));
    await assert.rejects(h.tx((s) => { s.exec("INSERT INTO t VALUES (2)"); throw new Error("x"); }));
    assert.deepEqual(await f.db.execute("SELECT n FROM t"), [{ n: 1 }]);
    assert.deepEqual(await h.tx((s) => s.exec("SELECT n FROM t")), [{ n: 1 }]);
  });

  it("rejects an async tx callback", async () => {
    const h = await RivetHost.activate(fakeActor().c);
    await assert.rejects(h.tx((async () => 1) as never), TypeError);
  });

  it("a newer activation fences the older one", async () => {
    const f = fakeActor();
    const old = await RivetHost.activate(f.c);
    await RivetHost.activate(f.c);
    await assert.rejects(old.tx((s) => s.exec("CREATE TABLE z (n)")), FencedError);
  });

  it("handleWake re-arms before the handler runs", async () => {
    const f = fakeActor();
    let now = 1000;
    const h = await RivetHost.activate(f.c, { now: () => now, retryDelayMs: 500 });
    await h.arm(new Date(1100), "obl");
    let armedWhenHandled = 0;
    h.onWake(async () => {
      armedWhenHandled = f.scheduled.length;
      throw new Error("fails");
    });
    now = 1200;
    await assert.rejects(h.handleWake("obl"), /fails/);
    assert.equal(armedWhenHandled, 2); // the retry timer existed before the handler
    assert.equal(f.scheduled[1]!.at, 1700);
    assert.deepEqual(f.cancelled, ["s1"]);
    assert.deepEqual(await h.handleWake("missing"), []);
  });

  it("startTask uses keepAwake once per name", async () => {
    const f = fakeActor();
    const h = await RivetHost.activate(f.c);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = h.startTask("turn", () => gate);
    const b = h.startTask("turn", () => gate);
    assert.equal(a, b);
    assert.equal(f.kept(), 1);
    release();
    await a;
  });

  it("sidecar sends the epoch and maps errors", async () => {
    const seen: Request[] = [];
    const h = await RivetHost.activate(fakeActor().c, {
      sidecars: {
        ok: { fetch: async (r) => (seen.push(r), Response.json({ v: 1 })) },
        bad: { fetch: async () => new Response("no", { status: 500 }) },
      },
    });
    assert.deepEqual(await h.sidecar("ok").call("m", {}), { v: 1 });
    assert.equal(seen[0]!.headers.get("x-hermesd-epoch"), "1");
    await assert.rejects(h.sidecar("bad").call("m", {}), SidecarError);
    await assert.rejects(h.sidecar("none").call("m", {}), /no sidecar/);
  });

  it("fetch honors an aborted signal", async () => {
    const h = await RivetHost.activate(fakeActor().c, { fetch: async () => new Response("x") });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(h.fetch(new Request("http://x/"), ac.signal));
  });
});
