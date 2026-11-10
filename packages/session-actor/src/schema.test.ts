import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { loadSurface } from "@hermesd/contracts";
import { PRESERVED_TABLES, renderUpstreamDdl, type SchemaSurface } from "./generate-ddl.ts";
import { PORT_TABLES } from "./migrate.ts";
import { PORT_DDL, applySessionSchema } from "./schema.ts";
import { sessionDb } from "./testing.ts";
import { PROFILE_UPSTREAM_DDL, SESSION_UPSTREAM_DDL, UPSTREAM_SCHEMA_VERSION } from "./upstream-ddl.ts";

// The preserved upstream tables at schema version 32 keep their column names
// and types byte-identical (guide 2.4, 6.4).

interface Surface extends SchemaSurface {
  tables: Array<SchemaSurface["tables"][number] & { columns: Array<{ name: string; definition: string }> }>;
}

const surface = loadSurface<Surface>("state-schema");

const upstream = (name: string) => surface.tables.find((t) => t.name === name && t.kind === "table")!;

describe("preserved upstream tables", () => {
  it("are at schema version 32", () => {
    assert.equal(UPSTREAM_SCHEMA_VERSION, 32);
    assert.equal(surface.schema_version, 32);
  });

  it("use upstream's own CREATE TABLE statements, byte for byte", () => {
    for (const name of PRESERVED_TABLES.session) assert.equal(SESSION_UPSTREAM_DDL[name], upstream(name).sql, name);
    for (const name of PRESERVED_TABLES.profile) assert.equal(PROFILE_UPSTREAM_DDL[name], upstream(name).sql, name);
  });

  it("have the same columns, types, defaults and keys as upstream (checked in SQLite)", () => {
    const reference = new DatabaseSync(":memory:");
    const ours = sessionDb().db;
    // Upstream's statements, run on their own database.
    for (const name of PRESERVED_TABLES.session) reference.exec(upstream(name).sql);
    for (const name of PRESERVED_TABLES.session) {
      const want = reference.prepare(`PRAGMA table_xinfo(${name})`).all();
      const have = ours.prepare(`PRAGMA table_xinfo(${name})`).all();
      assert.deepEqual(have, want, `${name}: table_info differs`);
      assert.deepEqual(
        ours.prepare(`PRAGMA foreign_key_list(${name})`).all(),
        reference.prepare(`PRAGMA foreign_key_list(${name})`).all(),
        `${name}: foreign keys differ`,
      );
      // And against the extracted column list, in order.
      assert.deepEqual(
        have.map((c) => c.name),
        upstream(name).columns.map((c) => c.name),
        `${name}: column names`,
      );
    }
  });

  it("are the same for the profile table", () => {
    const reference = new DatabaseSync(":memory:");
    const ours = new DatabaseSync(":memory:");
    reference.exec(upstream("conversation_generations").sql);
    for (const ddl of Object.values(PROFILE_UPSTREAM_DDL)) ours.exec(ddl);
    assert.deepEqual(ours.prepare("PRAGMA table_xinfo(conversation_generations)").all(), reference.prepare("PRAGMA table_xinfo(conversation_generations)").all());
  });

  it("match the generated file: no drift from contracts/upstream/state-schema.json", () => {
    const committed = readFileSync(new URL("./upstream-ddl.ts", import.meta.url), "utf8");
    assert.equal(committed, renderUpstreamDdl(surface), "run: node packages/session-actor/src/generate-ddl.ts");
  });

  it("enforce the foreign keys that upstream declares", () => {
    const { db } = sessionDb();
    assert.throws(() => db.exec("INSERT INTO messages (session_id, role, timestamp) VALUES ('missing', 'user', 0)"), /FOREIGN KEY/);
  });
});

describe("port tables", () => {
  it("each carries schema_version and data", () => {
    const { db } = sessionDb();
    for (const t of PORT_TABLES) {
      const names = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      assert.equal(names.includes("schema_version"), true, `${t} has schema_version`);
      assert.equal(names.includes("data"), true, `${t} has data`);
    }
  });

  it("pending_call is keyed by call_id and pending_op by op_id", () => {
    const { db } = sessionDb();
    const pk = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all().filter((c) => c.pk).map((c) => c.name);
    assert.deepEqual(pk("pending_call"), ["call_id"]);
    assert.deepEqual(pk("pending_op"), ["op_id"]);
  });

  it("can be created twice", () => {
    const { sql } = sessionDb();
    applySessionSchema(sql);
    assert.equal(PORT_DDL.length > 0, true);
  });
});
