import { DatabaseSync } from "node:sqlite";
import type { Sql, SqlRow, SqlValue } from "@hermesd/host";
import { applySessionSchema } from "./schema.ts";

/** A `Sql` over a plain node:sqlite database. For tests that need no platform. */
export function sqlOver(db: DatabaseSync): Sql {
  return {
    exec(query: string, ...params: SqlValue[]): SqlRow[] {
      return db.prepare(query).all(...(params as never[])).map((r) => ({ ...r })) as SqlRow[];
    },
  };
}

/** An in-memory database with the session actor's tables. */
export function sessionDb(): { db: DatabaseSync; sql: Sql } {
  const db = new DatabaseSync(":memory:");
  const sql = sqlOver(db);
  applySessionSchema(sql);
  return { db, sql };
}
