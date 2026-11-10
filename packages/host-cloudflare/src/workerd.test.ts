/**
 * Tests on real workerd, through Miniflare. They skip with a reason when
 * Miniflare or the workerd binary cannot start.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

type Json = Record<string, unknown> | Record<string, unknown>[];
interface Mf {
  dispatchFetch(url: string, init?: RequestInit): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;
  dispose(): Promise<void>;
  ready: Promise<unknown>;
}

const here = import.meta.dirname;
const persist = mkdtempSync(join(tmpdir(), "hermesd-do-"));
let mf: Mf | undefined;
let skipReason: string | false = false;

async function startMf(): Promise<Mf> {
  const { Miniflare } = await import("miniflare");
  const adapter = stripTypeScriptTypes(readFileSync(join(here, "index.ts"), "utf8"));
  const worker = readFileSync(join(here, "..", "test-worker", "worker.js"), "utf8");
  const m = new Miniflare({
    modules: [
      { type: "ESModule", path: "worker.js", contents: worker },
      { type: "ESModule", path: "adapter.js", contents: adapter },
    ],
    compatibilityDate: "2026-07-01",
    durableObjects: { TEST_OBJECT: { className: "TestObject", useSQLite: true } },
    durableObjectsPersist: persist,
  } as never) as unknown as Mf;
  await m.ready;
  return m;
}

async function call(path: string, name = "t1"): Promise<Json> {
  assert.ok(mf);
  const sep = path.includes("?") ? "&" : "?";
  const res = await mf.dispatchFetch(`http://do.test${path}${sep}name=${name}`);
  return (await res.json()) as Json;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  try {
    mf = await startMf();
    const res = await mf.dispatchFetch("http://do.test/epoch");
    if (res.status !== 200) throw new Error(`probe returned ${res.status}: ${await res.text()}`);
  } catch (e) {
    skipReason = `workerd is not available: ${e instanceof Error ? e.message : String(e)}`;
    mf = undefined;
  }
});

after(async () => {
  await mf?.dispose();
  rmSync(persist, { recursive: true, force: true });
});

describe("host-cloudflare on workerd", () => {
  it("epoch increases when the object restarts", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const a = (await call("/epoch", "ep")) as { epoch: number; id: string };
    const b = (await call("/epoch", "ep")) as { epoch: number };
    assert.equal(b.epoch, a.epoch, "same activation, same epoch");
    await call("/abort", "ep").catch(() => undefined);
    const c = (await call("/epoch", "ep")) as { epoch: number };
    assert.ok(c.epoch > a.epoch, `epoch ${c.epoch} should be above ${a.epoch}`);
  });

  it("tx rolls back when the callback throws", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const r = (await call("/tx-throw", "tx")) as { threw: string };
    assert.equal(r.threw, "boom");
    assert.deepEqual(await call("/rows", "tx"), []);
  });

  it("tx refuses an async callback and rolls back", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const r = (await call("/tx-async", "txa")) as { threw: string };
    assert.equal(r.threw, "TypeError");
    assert.deepEqual(await call("/rows", "txa"), []);
  });

  it("a row is there after commit, the reply, and a restart", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await call("/append?v=one", "cm");
    await call("/abort", "cm").catch(() => undefined);
    assert.deepEqual(await call("/rows", "cm"), [{ v: "one" }]);
  });

  it("arm sets the alarm to the earliest time and the alarm fires", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const now = Date.now();
    const late = now + 60_000;
    const soon = now + 700;
    await call(`/arm?key=late&at=${late}`, "al");
    const r = (await call(`/arm?key=soon&at=${soon}`, "al")) as { alarm: number };
    assert.equal(r.alarm, soon);
    const r2 = (await call(`/arm?key=later2&at=${late + 1}`, "al")) as { alarm: number };
    assert.equal(r2.alarm, soon, "a later obligation does not move the alarm");
    const log = await waitFor(async () => {
      const l = (await call("/alarm-log", "al")) as { key: string }[];
      return l.length > 0 ? l : undefined;
    });
    assert.deepEqual(log, [{ key: "soon" }]);
    const after = (await call("/alarm", "al")) as { alarm: number };
    assert.equal(after.alarm, late, "the alarm moved to the next obligation");
  });
});
