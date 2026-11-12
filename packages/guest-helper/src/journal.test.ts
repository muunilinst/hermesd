import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Journal, JournalCorruptError } from "./journal.ts";
import { makeTempDir } from "./testkit.ts";

const launching = (opId: string, attempt = 1) =>
  ({ type: "launching", opId, incarnation: 1, attempt, unit: `u-${attempt}`, cmd: "true", bootId: "b1" }) as const;

describe("Journal", () => {
  it("raises the sequence with every write and keeps it across reopen", () => {
    const dir = makeTempDir();
    const j = new Journal(join(dir, "j", "journal.log"));
    assert.equal(j.seq, 0);
    j.append(launching("a"));
    j.append({ type: "launched", opId: "a", attempt: 1, unit: "u-1", pid: 5, startTime: "9", bootId: "b1" });
    j.append({ type: "outcome", opId: "a", status: "done", exitCode: 0, bootId: "b1" });
    assert.equal(j.seq, 3);
    const again = new Journal(join(dir, "j", "journal.log"));
    assert.equal(again.seq, 3);
    assert.deepEqual(again.records.map((r) => r.seq), [1, 2, 3]);
    assert.equal(again.entry("a")?.outcome?.status, "done");
    assert.equal(again.entry("a")?.launched?.pid, 5);
  });

  it("drops a torn last line and goes on with the next sequence number", () => {
    const dir = makeTempDir();
    const path = join(dir, "journal.log");
    const j = new Journal(path);
    j.append(launching("a"));
    fs.appendFileSync(path, '{"seq":2,"type":"launch'); // a write cut off by a crash
    const again = new Journal(path);
    assert.equal(again.seq, 1);
    again.append(launching("b"));
    assert.deepEqual(new Journal(path).records.map((r) => r.seq), [1, 2]);
  });

  it("rejects a bad line in the middle", () => {
    const dir = makeTempDir();
    const path = join(dir, "journal.log");
    fs.writeFileSync(path, 'garbage\n{"seq":1}\n');
    assert.throws(() => new Journal(path), JournalCorruptError);
  });

  it("starts a new attempt after a launching record and clears the old outcome", () => {
    const dir = makeTempDir();
    const j = new Journal(join(dir, "journal.log"));
    j.append(launching("a", 1));
    j.append({ type: "outcome", opId: "a", status: "not_launched", bootId: "b1" });
    j.append(launching("a", 2));
    const e = j.entry("a");
    assert.equal(e?.attempt, 2);
    assert.equal(e?.outcome, undefined);
  });
});
