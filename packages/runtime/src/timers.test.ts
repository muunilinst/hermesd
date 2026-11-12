import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Host, Sql, SqlRow, SqlValue } from "@hermesd/host";
import { SessionActor } from "./index.ts";

// Races between an arm in flight and the cleanup of closed obligations' timers. The platform
// simulator runs one event at a time, so these use a small host that lets them overlap.

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const ticks = async (n = 50): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function world() {
  const db = new DatabaseSync(":memory:");
  const sql: Sql = { exec: (q: string, ...p: SqlValue[]) => db.prepare(q).all(...(p as never[])).map((r) => ({ ...r })) as SqlRow[] };
  let now = 1_000_000;
  const timers = new Map<string, number>();
  const w = {
    dead: false,
    /** Runs inside `arm`, before the timer is set: the arm is in flight. */
    onArm: null as null | ((key: string) => Promise<void>),
    /** Runs after an arm has set its timer. */
    afterArm: null as null | ((key: string) => void),
    /** Runs before each transaction. */
    onTx: null as null | (() => Promise<void>),
    /** Runs after a transaction, before its caller sees the result. */
    afterTx: null as null | (() => Promise<void>),
    /** Runs inside `disarm`, before the timer is removed. */
    onDisarm: null as null | ((key: string) => Promise<void>),
    /** Runs after each commit. */
    onCommit: null as null | (() => void),
    timers,
    clock: { now: () => now },
    advance: (ms: number) => (now += ms),
    rows: (q: string) => sql.exec(q),
    actor: null as unknown as SessionActor,
  };
  const host: Host = {
    id: () => "s1",
    epoch: () => 1,
    async tx<T>(fn: (s: Sql) => T): Promise<T> {
      if (w.dead) return never();
      await w.onTx?.();
      await ticks(1);
      db.exec("SAVEPOINT t");
      try {
        const r = fn(sql);
        db.exec("RELEASE t");
        await w.afterTx?.();
        return r;
      } catch (e) {
        db.exec("ROLLBACK TO t");
        db.exec("RELEASE t");
        throw e;
      }
    },
    async commit() {
      if (w.dead) return never();
      w.onCommit?.();
    },
    async arm(at, key) {
      if (w.dead) return never();
      const hook = w.onArm;
      if (hook) await hook(key);
      if (w.dead) return never();
      timers.set(key, at.getTime());
      w.afterArm?.(key);
    },
    async disarm(key) {
      if (w.dead) return never();
      await w.onDisarm?.(key);
      timers.delete(key);
    },
    fetch: () => never(),
    sidecar: () => ({ call: async <T>() => ({}) as T }),
  };
  w.actor = new SessionActor(host, {
    clock: w.clock,
    driver: { start: async () => {}, resume: async () => {} },
    jobs: { a: () => {}, b: () => {} },
  });
  return w;
}

/**
 * Schedule job a soon, then job b later. b borrows a's timer. While b's arm is in flight
 * ("inflight"), or after it landed and before b commits ("landed"), a comes due, runs and closes.
 */
async function raceSecondJob(w: ReturnType<typeof world>, when: "inflight" | "landed"): Promise<number> {
  await w.actor.activate();
  await ticks();
  const t0 = w.clock.now();
  await w.actor.call("schedule_job", { job: "a", dueAt: t0 + 30_000 });
  await ticks();
  let raced = false;
  const race = async (): Promise<void> => {
    if (raced) return;
    raced = true;
    w.advance(31_000);
    await w.actor.alarm(); // a runs, closes, and its timers are cleaned up
    await ticks();
  };
  if (when === "inflight") w.onArm = race;
  else {
    let landed = false;
    w.afterArm = () => (landed = true);
    w.onTx = async () => {
      if (landed) await race();
    };
  }
  const due = t0 + 300_000;
  await w.actor.call("schedule_job", { job: "b", dueAt: due });
  w.onArm = null;
  w.afterArm = null;
  w.onTx = null;
  assert.equal(w.rows("SELECT 1 FROM job_runs").length, 1, "job a ran during the race");
  return due;
}

describe("timers of closed obligations", () => {
  it("a crash right after the new obligation commits still leaves it a timer", async () => {
    const w = world();
    w.onCommit = () => {
      if (w.rows("SELECT 1 FROM wake_obligations WHERE ref = 'b' AND state = 'open'").length > 0) w.dead = true;
    };
    await Promise.race([raceSecondJob(w, "landed"), ticks(400)]);
    assert.equal(w.dead, true, "the actor died after b committed");
    const covering = [...w.timers.values()].filter((at) => at <= w.clock.now() + 300_000);
    assert.ok(covering.length > 0, "a timer covers job b");
  });

  it("an arm that lands after the cleanup does not leave a timer behind", async () => {
    const w = world();
    const due = await raceSecondJob(w, "inflight");
    await ticks(200);
    const open = w.rows("SELECT id FROM wake_obligations WHERE state = 'open'").map((r) => r.id);
    assert.deepEqual([...w.timers.keys()], open, "only the open obligation has a timer");
    assert.equal(w.timers.get(String(open[0])), due);
    assert.deepEqual(w.rows("SELECT key FROM rt_timers").map((r) => r.key), open);
  });

  it("a cleanup that started first does not remove a timer that a new obligation claimed", async () => {
    const w = world();
    await w.actor.activate();
    await ticks();
    const t0 = w.clock.now();
    await w.actor.call("schedule_job", { job: "a", dueAt: t0 + 30_000 });
    await ticks();
    // b reads a as the earliest open obligation. Before b goes on, a runs and closes, and the
    // cleanup decides a's timer is stale. While that disarm is in flight, b claims the timer and commits.
    let step: "read" | "cleanup" | "done" = "read";
    let release!: () => void;
    const bDone = new Promise<void>((r) => (release = r));
    let inDisarm!: () => void;
    const disarming = new Promise<void>((r) => (inDisarm = r));
    w.afterTx = async () => {
      if (step !== "read") return;
      step = "cleanup";
      w.advance(31_000);
      void w.actor.alarm();
      await disarming;
    };
    w.onDisarm = async () => {
      if (step !== "cleanup") return;
      step = "done";
      inDisarm();
      await bDone;
    };
    const due = t0 + 300_000;
    await w.actor.call("schedule_job", { job: "b", dueAt: due });
    w.afterTx = null;
    release();
    await ticks(300);
    w.onDisarm = null;
    assert.equal(step, "done", "the race happened");
    assert.equal(w.rows("SELECT 1 FROM job_runs").length, 1, "job a ran");
    const open = w.rows("SELECT id, due_at FROM wake_obligations WHERE state = 'open'");
    assert.equal(open.length, 1);
    assert.ok([...w.timers.values()].some((at) => at <= due), "job b still has a timer");
  });
});
