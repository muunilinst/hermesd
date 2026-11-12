import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Sql, SqlRow, SqlValue } from "@hermesd/host";
import { enqueueOutbox, FENCE_DDL, fenceEpoch, OUTBOX_DDL, resolveConfig, StaleEpochError } from "./index.ts";

// Small unit tests that need no platform. The fault tests in @hermesd/faults
// run the whole runtime on a platform.

function sqlOver(db: DatabaseSync): Sql {
  return {
    exec(query: string, ...params: SqlValue[]): SqlRow[] {
      return db.prepare(query).all(...(params as never[])).map((r) => ({ ...r })) as SqlRow[];
    },
  };
}

describe("runtime config", () => {
  it("uses 30 s as the minimum delay", () => {
    assert.equal(resolveConfig().minDelayMs, 30_000);
    assert.equal(resolveConfig({ minDelayMs: 5 }).minDelayMs, 5);
  });
});

describe("receiver fence", () => {
  it("accepts equal and higher epochs and refuses a lower one", () => {
    const sql = sqlOver(new DatabaseSync(":memory:"));
    sql.exec(FENCE_DDL);
    fenceEpoch(sql, "s1", 2);
    fenceEpoch(sql, "s1", 2);
    fenceEpoch(sql, "s1", 3);
    assert.throws(() => fenceEpoch(sql, "s1", 2), StaleEpochError);
    fenceEpoch(sql, "s2", 1); // another caller has its own epoch
  });
});

describe("outbox rows", () => {
  it("are plain rows with a growing ID that is never reused", () => {
    const db = new DatabaseSync(":memory:");
    const sql = sqlOver(db);
    sql.exec(OUTBOX_DDL);
    enqueueOutbox(sql, 1, "actor:profile", "index", { a: 1 });
    sql.exec("DELETE FROM outbox");
    enqueueOutbox(sql, 2, "actor:profile", "index", { a: 2 });
    const rows = sql.exec("SELECT id, payload FROM outbox");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, 2, "AUTOINCREMENT: a deleted ID is not used again, so it stays a safe idempotency key");
  });
});
