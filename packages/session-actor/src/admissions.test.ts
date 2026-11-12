import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { loadSurface } from "@hermesd/contracts";
import { SESSION_DDL } from "@hermesd/runtime";
import type { SchemaSurface } from "./generate-ddl.ts";

// The runtime's inbox is upstream's `session_admissions` (guide 2.4: "uses this
// table and its statuses; it does not invent a second inbox").

const surface = loadSurface<SchemaSurface>("state-schema");
const ledger = loadSurface<{ tables: Record<string, { status_set: string[]; unique_constraints: string[][] }> }>("ledger");
const upstreamSql = surface.tables.find((t) => t.name === "session_admissions" && t.kind === "table")!.sql;

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const ddl of SESSION_DDL) db.exec(ddl);
  return db;
}

describe("runtime session_admissions", () => {
  it("has upstream's columns, types, defaults and primary key", () => {
    const reference = new DatabaseSync(":memory:");
    reference.exec(upstreamSql);
    const want = reference.prepare("PRAGMA table_xinfo(session_admissions)").all();
    const got = open().prepare("PRAGMA table_xinfo(session_admissions)").all();
    assert.deepEqual(got, want);
  });

  it("has upstream's unique rules", () => {
    const db = open();
    const unique = (db.prepare("PRAGMA index_list(session_admissions)").all() as Array<{ name: string; unique: number }>)
      .filter((i) => i.unique === 1)
      .map((i) => (db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>).map((c) => c.name).sort());
    const want = ledger.tables["session_admissions"]!.unique_constraints.map((c) => [...c].sort());
    assert.deepEqual(unique.sort(), want.sort());
  });

  it("accepts the upstream statuses and nothing else", () => {
    const db = open();
    const insert = (status: string): void => {
      db.prepare(
        `INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status, owner_epoch, generation)
         VALUES (?, ?, 'p', 's', '{}', '{}', 'd', 'queue', ?, 1, 1)`,
      ).run(`a-${status}`, `r-${status}`, status);
    };
    for (const s of ledger.tables["session_admissions"]!.status_set) insert(s);
    assert.throws(() => insert("done"));
    assert.throws(() => insert("failed"));
  });

  it("has the same CHECK rule: a started row has an owner epoch and a generation", () => {
    const db = open();
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status)
           VALUES ('a', 'r', 'p', 's', '{}', '{}', 'd', 'queue', 'started')`,
        )
        .run(),
    );
  });
});
