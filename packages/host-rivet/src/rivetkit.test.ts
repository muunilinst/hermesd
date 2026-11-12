/**
 * Tests on the real rivetkit 3.0 runtime, in this process, through the
 * official `rivetkit/test` helper (`setupTest`). They skip with a reason when
 * rivetkit cannot start (for example, no native engine for this platform).
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { RivetHost } from "./index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const SLEEP_MS = 800;
let client: Any;
let registry: Any;
let anyFailed = false;
let skip: string | false = false;
const finishers: Array<() => Promise<void> | void> = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyOf = (n: string) => [`${n}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`];

/** Poll until `fn` returns a truthy value. */
async function until<T>(fn: () => Promise<T>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await pause(50);
  }
}

async function build(): Promise<Any> {
  const { actor, setup } = (await import("rivetkit")) as Any;
  const { db } = (await import("rivetkit/db")) as Any;
  const { setupTest } = (await import("rivetkit/test")) as Any;

  /** One actor with the adapter. `kept` false starts the slow task without keepAwake. */
  const make = (kept: boolean) =>
    actor({
      db: db(),
      options: { sleepTimeout: SLEEP_MS },
      onWake: async (c: Any) => {
        const host = await RivetHost.activate(c, { retryDelayMs: 300 });
        await host.tx((s) => {
          s.exec("CREATE TABLE IF NOT EXISTS session_admissions (id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL)");
          s.exec("CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY, text TEXT NOT NULL)");
          s.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT NOT NULL)");
        });
        let failOnce = true;
        host.onWake(async (keys) => {
          const row = await host.tx((s) => s.exec("SELECT fire_ms FROM wake_timers WHERE key = ?", keys[0]!)[0]);
          const rearmed = Number(row?.["fire_ms"]) > Date.now();
          await host.tx((s) => s.exec("INSERT INTO events (what) VALUES (?)", `handler:rearmed=${rearmed}`));
          if (failOnce) {
            failOnce = false;
            throw new Error("first run fails");
          }
          await host.disarm(keys[0]!);
        });
        // Drain whatever is queued (also after a restart: the rows are durable).
        const work = (signal: AbortSignal) => drain(host, signal);
        if (kept) void host.startTask("turn", work);
        else void work(c.abortSignal).catch(cutOff);
      },
      actions: {
        epoch: (c: Any) => RivetHost.of(c).epoch(),
        stored: async (c: Any) => Number((await c.db.execute("SELECT v FROM host_meta WHERE k = 'owner_epoch'"))[0].v),
        sleepNow: (c: Any) => c.sleep(),
        // An inbound message: one admission row, commit, ack, return.
        receive: async (c: Any, id: string, text: string, crash?: "before" | "after") => {
          const host = RivetHost.of(c);
          if (crash === "before") throw new Error("crash before the admission write");
          await host.tx((s) => s.exec("INSERT OR IGNORE INTO session_admissions (id, text, status) VALUES (?, ?, 'queued')", id, text));
          if (crash === "after") throw new Error("crash before the ack");
          if (kept) void host.startTask("turn", (signal) => drain(host, signal));
          else void drain(host, c.abortSignal).catch(cutOff);
          return "ack";
        },
        admissions: (c: Any) => RivetHost.of(c).tx((s) => s.exec("SELECT id, status FROM session_admissions ORDER BY id")),
        // Compare-and-set append: the read and the write are in one tx.
        append: (c: Any, expectedTail: number, text: string) =>
          RivetHost.of(c).tx((s) => {
            const tail = Number(s.exec("SELECT COALESCE(MAX(seq), 0) AS t FROM log")[0]!["t"]);
            if (tail !== expectedTail) return { ok: false, tail };
            s.exec("INSERT INTO log (seq, text) VALUES (?, ?)", tail + 1, text);
            return { ok: true, tail: tail + 1 };
          }),
        failingTx: async (c: Any) => {
          const host = RivetHost.of(c);
          await host.tx((s) => s.exec("INSERT INTO log (seq, text) VALUES (100, 'kept')"));
          await host.tx((s) => {
            s.exec("INSERT INTO log (seq, text) VALUES (101, 'lost')");
            throw new Error("boom");
          }).catch(() => undefined);
        },
        logRows: (c: Any) => RivetHost.of(c).tx((s) => s.exec("SELECT seq FROM log ORDER BY seq")),
        armIn: async (c: Any, ms: number) => RivetHost.of(c).arm(new Date(Date.now() + ms), "obl"),
        hostWake: async (c: Any, key: string) => {
          await RivetHost.of(c).handleWake(key);
        },
        events: (c: Any) => RivetHost.of(c).tx((s) => s.exec("SELECT what FROM events ORDER BY id")),
        timers: (c: Any) => RivetHost.of(c).tx((s) => s.exec("SELECT key FROM wake_timers")),
      },
    });

  /**
   * A turn outside keepAwake can be cut off by sleep: its next write finds the
   * database closed. That is the outcome the control expects, so it is not an error.
   * When the actor's abort signal fires first (it does on node, not on bun) the
   * turn returns before that write.
   */
  const cutOff = (e: unknown): void => {
    if (!(e instanceof Error && /Database is closed/.test(e.message))) throw e;
  };

  /** The turn: take queued rows one by one. "slow" waits longer than sleepTimeout. */
  async function drain(host: RivetHost, signal: AbortSignal): Promise<void> {
    for (;;) {
      const row = await host.tx((s) => s.exec("SELECT id, text FROM session_admissions WHERE status = 'queued' ORDER BY id LIMIT 1")[0]);
      if (!row || signal.aborted) return;
      if (row["text"] === "slow") await pause(SLEEP_MS * 3);
      await host.tx((s) => {
        s.exec("UPDATE session_admissions SET status = 'done' WHERE id = ?", row["id"]!);
        s.exec("INSERT INTO events (what) VALUES (?)", `turn:${row["id"]}`);
      });
    }
  }

  registry = setup({ use: { kept: make(true), lazy: make(false) } });
  const { client } = await setupTest({ onTestFinished: (f: () => Promise<void>) => finishers.push(f) }, registry);
  return client;
}

describe("RivetHost on real rivetkit", () => {
  before(async () => {
    try {
      client = await build();
    } catch (e) {
      skip = `rivetkit could not start here: ${(e as Error).message.slice(0, 200)}`;
    }
  });
  afterEach((t) => {
    if ((t as Any).passed === false) anyFailed = true;
  });
  after(async () => {
    for (const f of finishers) await f();
    // Stop the engine, or its child process stays after the tests.
    await registry?.shutdown();
    // Under node --test the native runtime keeps this file's process alive after
    // shutdown (found by test: with no exit the file hangs), so leave once the
    // reporter has finished. bun runs every test file in one process: an exit
    // here would end the whole run, with code 0, before the other files ran.
    if (!process.versions.bun) setTimeout(() => process.exit(anyFailed ? 1 : 0), 2000).unref();
  });

  it("raises the epoch at every wake", { timeout: 30000 }, (t) => {
    if (skip) return t.skip(skip);
    return (async () => {
      const h = client.kept.getOrCreate(keyOf("epoch"));
      const e1 = await h.epoch();
      assert.equal(e1, await h.stored());
      await h.sleepNow();
      const e2 = await until(async () => {
        const e = await h.epoch();
        return e > e1 ? e : 0;
      });
      assert.equal(e2, e1 + 1);
      assert.equal(await h.stored(), e2);
    })();
  });

  it("tx is atomic: a throw leaves no row, in memory or in c.db", { timeout: 30000 }, (t) => {
    if (skip) return t.skip(skip);
    return (async () => {
      const h = client.kept.getOrCreate(keyOf("tx"));
      await h.failingTx();
      assert.deepEqual(await h.logRows(), [{ seq: 100 }]);
      await h.sleepNow(); // the next wake reloads the mirror from c.db
      await until(async () => {
        const rows = await h.logRows();
        return rows.length === 1;
      });
      assert.deepEqual(await h.logRows(), [{ seq: 100 }]);
    })();
  });

  it("a schedule fires, and the handler re-arms first (a failed run is retried)", { timeout: 30000 }, (t) => {
    if (skip) return t.skip(skip);
    return (async () => {
      const h = client.kept.getOrCreate(keyOf("timer"));
      await h.armIn(200);
      const events = await until(async () => {
        const ev: { what: string }[] = await h.events();
        return ev.filter((e) => e.what.startsWith("handler")).length >= 2 ? ev : null;
      });
      // First run throws. The second run exists only because the first re-armed before it threw.
      assert.deepEqual((events as Any[]).map((e: { what: string }) => e.what).slice(0, 2), ["handler:rearmed=true", "handler:rearmed=true"]);
      await until(async () => (await h.timers()).length === 0);
    })();
  });

  it("two parallel actions do not both append", { timeout: 30000 }, (t) => {
    if (skip) return t.skip(skip);
    return (async () => {
      const h = client.kept.getOrCreate(keyOf("cas"));
      const results: { ok: boolean }[] = await Promise.all([h.append(0, "a"), h.append(0, "b"), h.append(0, "c")]);
      assert.equal(results.filter((r) => r.ok).length, 1); // the others saw the new tail and lost
      assert.deepEqual(await h.logRows(), [{ seq: 1 }]);
    })();
  });

  it("a crash between receive and the admission write loses nothing", { timeout: 30000 }, (t) => {
    if (skip) return t.skip(skip);
    return (async () => {
      const h = client.kept.getOrCreate(keyOf("crash"));
      // The action dies before the write: no ack, so the sender retries.
      await assert.rejects(h.receive("m1", "hello", "before"));
      assert.deepEqual(await h.admissions(), []);
      // The action dies after the write, before the ack: the retry is a no-op.
      await assert.rejects(h.receive("m2", "again", "after"));
      assert.equal((await h.admissions()).length, 1);
      assert.equal(await h.receive("m1", "hello"), "ack");
      assert.equal(await h.receive("m2", "again"), "ack");
      assert.equal((await h.admissions()).length, 2);
      await until(async () => (await h.admissions()).every((r: { status: string }) => r.status === "done"));
      const turns = (await h.events()).filter((e: { what: string }) => e.what.startsWith("turn:"));
      assert.equal(turns.length, 2); // each message ran once
    })();
  });

  it("a turn longer than sleepTimeout stays awake under keepAwake, and not without it", { timeout: 60000 }, (t) => {
    if (skip) return t.skip(skip);
    return (async () => {
      const kept = client.kept.getOrCreate(keyOf("kept"));
      const e0 = await kept.epoch();
      assert.equal(await kept.receive("s1", "slow"), "ack");
      await until(async () => (await kept.admissions()).every((r: { status: string }) => r.status === "done"), 15000);
      assert.equal(await kept.epoch(), e0, "kept actor must not have slept");

      const lazy = client.lazy.getOrCreate(keyOf("lazy"));
      const l0 = await lazy.epoch();
      // The control: the same slow turn with no keepAwake. The actor sleeps under it.
      assert.equal(await lazy.receive("s1", "slow"), "ack");
      await pause(SLEEP_MS * 4);
      assert.ok((await lazy.epoch()) > l0, "control actor should have slept and woken");
    })();
  });
});
