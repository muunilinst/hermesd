import type { Sql, SqlRow } from "@hermesd/host";
import { num, str } from "@hermesd/runtime";
import { UPSTREAM_SCHEMA_VERSION } from "./upstream-ddl.ts";

/**
 * Row versions and forward-only migration (porting guide 7.4, "upgrade tests").
 *
 * Every row that the port itself owns carries `schema_version` and a JSON
 * `data` column. A migration is a function from one version to the next. It
 * runs on the first read of a row, inside the transaction that reads it, and
 * the migrated row is written back at once. A row is never migrated down: code
 * that meets a row from a newer version stops with `RowFromFutureError`.
 *
 * The upstream tables (`sessions`, `messages`, ...) keep their columns
 * byte-identical, so they have no `schema_version` column. Their version is
 * the upstream schema version, `UPSTREAM_SCHEMA_VERSION`.
 */

/** The tables of the port that carry `schema_version` and `data`. */
export const PORT_TABLES = ["pending_call", "pending_op", "clarify_question", "todo_item", "loop_turn", "compaction_link"] as const;
export type PortTable = (typeof PORT_TABLES)[number];

export type RowData = Record<string, unknown>;
/** Rewrites the `data` of one row from version N to version N+1. It must not read the clock or the database. */
export type DataMigration = (data: RowData) => RowData;

export interface MigrationSet {
  /** The version that this code writes and reads. */
  current: number;
  /** `steps[n][table]` takes a row of version n to version n + 1. A missing entry leaves the data as it is. */
  steps: Readonly<Record<number, Partial<Record<PortTable, DataMigration>>>>;
}

/** Version 32 is the first version of the port: it matches the upstream schema version. No step exists yet. */
export const DEFAULT_MIGRATIONS: MigrationSet = { current: UPSTREAM_SCHEMA_VERSION, steps: {} };

export class RowFromFutureError extends Error {
  readonly code = "row_from_future";
  constructor(table: string, version: number, current: number) {
    super(`${table} row has schema_version ${version}, newer than this code (${current}); migrations only go forward`);
    this.name = "RowFromFutureError";
  }
}

/** Apply the steps from `from` up to the current version. Pure. */
export function migrateData(set: MigrationSet, table: PortTable, from: number, data: RowData): RowData {
  if (from > set.current) throw new RowFromFutureError(table, from, set.current);
  let out = data;
  for (let v = from; v < set.current; v++) out = set.steps[v]?.[table]?.(out) ?? out;
  return out;
}

/** A row of a port table after migration. `key` is the value of the first column. */
export interface PortRow {
  row: SqlRow;
  data: RowData;
}

/**
 * Read rows of a port table. Rows of an older version are migrated and
 * written back before they are returned. Call it inside a transaction.
 */
export function readPortRows(sql: Sql, set: MigrationSet, table: PortTable, where = "1 = 1", ...params: Array<string | number>): PortRow[] {
  const rows = sql.exec(`SELECT rowid AS _rowid, * FROM ${table} WHERE ${where}`, ...params);
  return rows.map((row) => {
    const from = num(row.schema_version);
    let data = JSON.parse(str(row.data)) as RowData;
    if (from !== set.current) {
      data = migrateData(set, table, from, data);
      sql.exec(`UPDATE ${table} SET data = ?, schema_version = ? WHERE rowid = ?`, JSON.stringify(data), set.current, num(row._rowid));
    }
    return { row, data };
  });
}

export function readPortRow(sql: Sql, set: MigrationSet, table: PortTable, where: string, ...params: Array<string | number>): PortRow | undefined {
  return readPortRows(sql, set, table, where, ...params)[0];
}
