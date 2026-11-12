import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MIGRATIONS, RowFromFutureError, migrateData, readPortRow, readPortRows, type MigrationSet } from "./migrate.ts";
import { insertPortRow } from "./messages.ts";
import { sessionDb } from "./testing.ts";

// Guide 7.4: every row carries schema_version, and a migration is a
// forward-only function per version that runs on first read. Version 32 is
// the only version so far, so the mechanism is tested with made-up versions.

const V34: MigrationSet = {
  current: 34,
  steps: {
    32: { clarify_question: (d) => ({ ...d, v33: true }) },
    33: { clarify_question: (d) => ({ ...d, v34: true }), todo_item: (d) => ({ ...d, renamed: d.content }) },
  },
};

const seed = (set: MigrationSet, uid = "u1"): ReturnType<typeof sessionDb> => {
  const t = sessionDb();
  insertPortRow(t.sql, set, "clarify_question", { tool_call_uid: uid, turn_id: "t", status: "open", created_at: 1 }, { questions: ["q"] });
  return t;
};

describe("row migration", () => {
  it("the default set is version 32 and has no steps", () => {
    assert.equal(DEFAULT_MIGRATIONS.current, 32);
    assert.deepEqual(DEFAULT_MIGRATIONS.steps, {});
    const { sql } = seed(DEFAULT_MIGRATIONS);
    const row = readPortRow(sql, DEFAULT_MIGRATIONS, "clarify_question", "tool_call_uid = ?", "u1")!;
    assert.deepEqual(row.data, { questions: ["q"] });
    assert.equal(sql.exec("SELECT schema_version FROM clarify_question")[0]!.schema_version, 32);
  });

  it("runs every step from the row's version up to the current one, in order", () => {
    assert.deepEqual(migrateData(V34, "clarify_question", 32, { a: 1 }), { a: 1, v33: true, v34: true });
    assert.deepEqual(migrateData(V34, "clarify_question", 33, { a: 1 }), { a: 1, v34: true });
    assert.deepEqual(migrateData(V34, "clarify_question", 34, { a: 1 }), { a: 1 });
    assert.deepEqual(migrateData(V34, "pending_op", 32, { a: 1 }), { a: 1 }, "a table without a step is left as it is");
  });

  it("migrates on first read and writes the row back at the new version", () => {
    const { sql } = seed(DEFAULT_MIGRATIONS);
    const row = readPortRow(sql, V34, "clarify_question", "tool_call_uid = ?", "u1")!;
    assert.deepEqual(row.data, { questions: ["q"], v33: true, v34: true });
    const stored = sql.exec("SELECT schema_version, data FROM clarify_question")[0]!;
    assert.equal(stored.schema_version, 34);
    assert.deepEqual(JSON.parse(String(stored.data)), { questions: ["q"], v33: true, v34: true });
  });

  it("does not touch a row that is not read", () => {
    const { sql } = seed(DEFAULT_MIGRATIONS, "unread");
    readPortRows(sql, V34, "todo_item"); // another table
    assert.equal(sql.exec("SELECT schema_version FROM clarify_question")[0]!.schema_version, 32);
  });

  it("runs a step once: a second read finds the row current", () => {
    const { sql } = seed(DEFAULT_MIGRATIONS);
    let runs = 0;
    const counting: MigrationSet = { current: 33, steps: { 32: { clarify_question: (d) => (runs++, { ...d, n: runs }) } } };
    readPortRows(sql, counting, "clarify_question");
    readPortRows(sql, counting, "clarify_question");
    assert.equal(runs, 1);
  });

  it("goes forward only: a row from a newer version stops old code", () => {
    const { sql } = seed(V34);
    assert.throws(() => readPortRows(sql, DEFAULT_MIGRATIONS, "clarify_question"), RowFromFutureError);
    assert.throws(() => migrateData(DEFAULT_MIGRATIONS, "clarify_question", 33, {}), /migrations only go forward/);
    assert.equal(sql.exec("SELECT schema_version FROM clarify_question")[0]!.schema_version, 34, "the row was not changed");
  });

  it("a failing step leaves the row at its old version (the read is in a transaction)", () => {
    const { db, sql } = seed(DEFAULT_MIGRATIONS);
    const bad: MigrationSet = { current: 33, steps: { 32: { clarify_question: () => { throw new Error("boom"); } } } };
    db.exec("BEGIN");
    assert.throws(() => readPortRows(sql, bad, "clarify_question"), /boom/);
    db.exec("ROLLBACK");
    assert.equal(sql.exec("SELECT schema_version FROM clarify_question")[0]!.schema_version, 32);
  });
});
