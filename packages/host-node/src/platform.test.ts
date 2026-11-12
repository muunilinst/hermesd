import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Host } from "@hermesd/host";
import { CrashError, NodePlatform, StaleEpochError, type ActorBehavior, type PlatformMode } from "./index.ts";

/** A small actor for the platform tests. */
function counter(host: Host, log: string[] = []): ActorBehavior {
  return {
    async activate() {
      await host.tx((sql) => sql.exec("CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v INTEGER)"));
      await host.commit();
    },
    async alarm() {
      log.push("alarm");
    },
    async call(method, params) {
      const p = (params ?? {}) as { k?: string };
      switch (method) {
        case "put":
          await host.tx((sql) => sql.exec("INSERT OR REPLACE INTO t VALUES (?, 1)", p.k ?? "a"));
          await host.commit();
          return "ok";
        case "put-nocommit":
          await host.tx((sql) => sql.exec("INSERT OR REPLACE INTO t VALUES (?, 1)", p.k ?? "a"));
          return "ok";
        case "epoch":
          return host.epoch();
        case "arm":
          await host.arm(new Date((params as { at: number }).at), "k1");
          return "armed";
        default:
          throw new Error(`no method ${method}`);
      }
    },
  };
}

const MODES: PlatformMode[] = ["durable-objects", "rivet"];

for (const mode of MODES) {
  describe(`NodePlatform (${mode})`, () => {
    it("keeps committed rows over a crash and rolls back the rest", async () => {
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => counter(h));
      await p.call("a", "put", { k: "kept" });
      // The transaction function runs but the actor crashes before it commits.
      p.crashAt({ actor: "a", point: "tx:before-commit" });
      await assert.rejects(p.call("a", "put", { k: "lost" }), CrashError);
      assert.deepEqual(p.query("a", "SELECT k FROM t ORDER BY k").map((r) => r.k), ["kept"]);
      assert.equal(p.isActive("a"), false);
      // The next call starts a new activation with a higher epoch.
      assert.equal(await p.call("a", "epoch"), 2);
      p.close();
    });

    it("raises owner_epoch in the actor's SQLite at every activation", async () => {
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => counter(h));
      assert.equal(await p.call("a", "epoch"), 1);
      p.crash("a");
      assert.equal(await p.call("a", "epoch"), 2);
      p.crash("a");
      assert.equal(await p.call("a", "epoch"), 3);
      assert.equal(p.epochOf("a"), 3);
      p.close();
    });

    it("keeps one alarm: a new arm replaces the old one (single-alarm mode) and the alarm fires on time", async () => {
      const log: string[] = [];
      const p = new NodePlatform({ mode, multiAlarm: false });
      p.defineActor("a", (h) => counter(h, log));
      const t0 = p.clock.now();
      await p.call("a", "arm", { at: t0 + 10_000 });
      await p.call("a", "arm", { at: t0 + 20_000 });
      assert.equal(p.alarmOf("a")?.at, t0 + 20_000);
      await p.clock.advance(15_000);
      assert.deepEqual(log, []);
      await p.clock.advance(5_000);
      assert.deepEqual(log, ["alarm"]);
      assert.equal(p.alarmOf("a"), null);
      p.close();
    });

    it("the alarm survives a crash and wakes the actor", async () => {
      const log: string[] = [];
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => counter(h, log));
      await p.call("a", "arm", { at: p.clock.now() + 1000 });
      p.crash("a");
      assert.equal(p.isActive("a"), false);
      await p.clock.advance(1000);
      assert.deepEqual(log, ["alarm"]);
      assert.equal(p.isActive("a"), true);
      p.close();
    });

    it("makes the alarm durable at the moment arm resolves (crash after arm keeps it)", async () => {
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => counter(h));
      p.crashAt({ actor: "a", point: "arm:after" });
      await assert.rejects(p.call("a", "arm", { at: p.clock.now() + 5000 }), CrashError);
      assert.ok(p.alarmOf("a"));
      p.close();
    });

    it("leaves no alarm when a crash comes before arm completes", async () => {
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => counter(h));
      p.crashAt({ actor: "a", point: "arm:before" });
      await assert.rejects(p.call("a", "arm", { at: p.clock.now() + 5000 }), CrashError);
      assert.equal(p.alarmOf("a"), null);
      p.close();
    });

    it("fails arm on request and sets nothing", async () => {
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => counter(h));
      p.failArm("a");
      await assert.rejects(p.call("a", "arm", { at: p.clock.now() + 5000 }), /arm failed/);
      assert.equal(p.alarmOf("a"), null);
      await p.call("a", "arm", { at: p.clock.now() + 5000 });
      assert.ok(p.alarmOf("a"));
      p.close();
    });

    it("deletes the timer and fires it early on request", async () => {
      const log: string[] = [];
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => counter(h, log));
      await p.call("a", "arm", { at: p.clock.now() + 60_000 });
      await p.fireTimerEarly("a");
      assert.deepEqual(log, ["alarm"]);
      assert.ok(p.alarmOf("a"), "an early fire does not consume a timer that is not due");
      p.deleteTimer("a");
      await p.clock.advance(120_000);
      assert.deepEqual(log, ["alarm"]);
      p.close();
    });

    it("rejects a write from an activation with a lower epoch", async () => {
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => counter(h));
      await p.call("a", "put", { k: "x" });
      const { old, fresh } = await p.splitBrain("a");
      assert.ok(fresh.epoch > old.epoch);
      await assert.rejects(old.call("put", { k: "zombie" }), StaleEpochError);
      await fresh.call("put", { k: "new" });
      assert.deepEqual(p.query("a", "SELECT k FROM t ORDER BY k").map((r) => r.k), ["new", "x"]);
      p.close();
    });

    it("lets one actor call another through a sidecar name", async () => {
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => ({
        async call() {
          return h.sidecar("actor:b").call("epoch", {});
        },
      }));
      p.defineActor("b", (h) => counter(h));
      assert.equal(await p.call("a", "go"), 1);
      p.close();
    });

    it("runs cron schedules on the virtual clock", async () => {
      const ticks: string[] = [];
      const p = new NodePlatform({ mode });
      p.defineActor("a", () => ({
        async cron(name) {
          ticks.push(name);
        },
        async call() {
          return null;
        },
      }));
      p.cron("a", "tick", 60_000);
      await p.clock.advance(185_000);
      assert.equal(ticks.length, 3);
      p.close();
    });

    it("keeps rows in a temp file across platform crashes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hermesd-"));
      try {
        const p = new NodePlatform({ mode, dir });
        p.defineActor("a/b", (h) => counter(h));
        await p.call("a/b", "put", { k: "file" });
        p.crash("a/b");
        assert.deepEqual(p.query("a/b", "SELECT k FROM t").map((r) => r.k), ["file"]);
        p.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

describe("NodePlatform interleaving", () => {
  /**
   * An actor that reads a counter, awaits something, then writes counter + 1.
   * `wait` is "storage" (await another tx) or "fetch" (await host.fetch).
   */
  function racer(host: Host, wait: "storage" | "fetch"): ActorBehavior {
    return {
      async activate() {
        await host.tx((sql) => sql.exec("CREATE TABLE IF NOT EXISTS n (v INTEGER)"));
        await host.tx((sql) => sql.exec("INSERT INTO n VALUES (0)"));
        await host.commit();
      },
      async call() {
        const seen = await host.tx((sql) => Number(sql.exec("SELECT v FROM n")[0]!.v));
        if (wait === "fetch") await host.fetch(new Request("http://x.test/"));
        else await host.tx((sql) => sql.exec("SELECT 1"));
        await host.tx((sql) => sql.exec("UPDATE n SET v = ?", seen + 1));
        return seen;
      },
    };
  }

  async function race(mode: PlatformMode, wait: "storage" | "fetch"): Promise<number> {
    const p = new NodePlatform({ mode });
    p.defineActor("a", (h) => racer(h, wait));
    await p.call("a", "warm");
    await Promise.all([p.call("a", "go"), p.call("a", "go")]);
    const v = Number(p.query("a", "SELECT v FROM n")[0]!.v);
    p.close();
    return v;
  }
  // The "warm" call above also runs the read-write once, so a safe run ends at 3 and a lost update at 2.

  it("Durable Objects: read, await storage, write is safe (the input gate)", async () => {
    assert.equal(await race("durable-objects", "storage"), 3);
  });

  it("Durable Objects: read, await fetch, write loses an update (another event runs during the fetch)", async () => {
    assert.equal(await race("durable-objects", "fetch"), 2);
  });

  it("Rivet: actions interleave at every await, also around storage", async () => {
    assert.equal(await race("rivet", "storage"), 2);
    assert.equal(await race("rivet", "fetch"), 2);
  });

  it("Durable Objects: the output gate makes writes durable before a reply leaves", async () => {
    const p = new NodePlatform({ mode: "durable-objects" });
    p.defineActor("a", (h) => counter(h));
    // The call never commits by itself. The reply gate flushes. The actor then crashes before the reply.
    p.crashAt({ actor: "a", point: "reply:before" });
    await assert.rejects(p.call("a", "put-nocommit", { k: "gate" }), CrashError);
    assert.deepEqual(p.query("a", "SELECT k FROM t").map((r) => r.k), ["gate"]);
    p.close();
  });

  it("Durable Objects: a crash before the write buffer is flushed loses the row", async () => {
    const p = new NodePlatform({ mode: "durable-objects" });
    p.defineActor("a", (h) => counter(h));
    p.crashAt({ actor: "a", point: "tx:after", method: "put-nocommit" });
    await assert.rejects(p.call("a", "put-nocommit", { k: "buffered" }), CrashError);
    assert.deepEqual(p.query("a", "SELECT k FROM t"), []);
    p.close();
  });

  it("retries a failed alarm on Durable Objects and does not on Rivet", async () => {
    for (const mode of MODES) {
      let runs = 0;
      const p = new NodePlatform({ mode });
      p.defineActor("a", (h) => ({
        ...counter(h),
        async alarm() {
          runs += 1;
          throw new Error("boom");
        },
      }));
      await p.call("a", "arm", { at: p.clock.now() + 1000 });
      await p.clock.advance(1000 + 200_000);
      assert.equal(runs, mode === "durable-objects" ? 1 + 6 : 1, mode);
      p.close();
    }
  });
});
