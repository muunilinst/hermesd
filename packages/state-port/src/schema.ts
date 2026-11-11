import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadSurface } from "@hermesd/contracts";

/**
 * The DDL of an upstream-shaped `state.db` at schema version 32, read from
 * `contracts/upstream/state-schema.json`.
 *
 * What the file has and what it does not:
 * - Every table that upstream makes in its schema script (17 tables) is made
 *   from upstream's own `CREATE TABLE` text. Tables that upstream makes later,
 *   on first use (`delivery_obligations`, the two Telegram topic tables), are
 *   not made.
 * - Each index is built from the columns and the WHERE text in the file. The
 *   file has no `CREATE INDEX` text, so these statements are ours. An index
 *   whose WHERE text has a placeholder is left out.
 * - The file has no text for the triggers. They are not made. Upstream makes
 *   them when it opens the file. See NOTES.md.
 * - The two FTS5 tables are made by `regenerateFts` and are not part of this
 *   list. Their layout changes between upstream versions.
 */

export const SCHEMA_VERSION = 32;

interface StateSurface {
  schema_version: number | null;
  tables: Array<{
    name: string;
    kind: string;
    created_lazily: boolean;
    sql: string;
    indexes: Array<{ name: string; table: string; columns: string[]; unique: boolean; where: string | null }>;
  }>;
}

export interface UpstreamDdl {
  /** `CREATE TABLE` statements in the order of the file. */
  tables: Array<{ name: string; sql: string }>;
  /** `CREATE INDEX` statements, once for each name. */
  indexes: Array<{ name: string; table: string; sql: string }>;
}

let cached: UpstreamDdl | undefined;

export function upstreamDdl(): UpstreamDdl {
  if (cached) return cached;
  const surface = loadSurface<StateSurface>("state-schema");
  if (surface.schema_version !== SCHEMA_VERSION) throw new Error(`state-schema.json is at version ${String(surface.schema_version)}, not ${SCHEMA_VERSION}`);
  const tables: UpstreamDdl["tables"] = [];
  const indexes: UpstreamDdl["indexes"] = [];
  const seen = new Set<string>();
  for (const t of surface.tables) {
    if (t.kind !== "table" || t.created_lazily) continue;
    tables.push({ name: t.name, sql: t.sql });
    for (const i of t.indexes) {
      if (seen.has(i.name)) continue;
      seen.add(i.name);
      if (i.where?.includes("{")) continue; // a placeholder we cannot fill
      const where = i.where ? ` WHERE ${i.where}` : "";
      indexes.push({
        name: i.name,
        table: i.table,
        sql: `CREATE ${i.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${i.name} ON ${i.table} (${i.columns.join(", ")})${where}`,
      });
    }
  }
  cached = { tables, indexes };
  return cached;
}

/** The names of the 17 tables of an upstream-shaped file. */
export function upstreamTableNames(): string[] {
  return upstreamDdl().tables.map((t) => t.name);
}

/** The four ledger tables. A partial export leaves them out (guide 2.4, `upstream-recovery.md` section 1). */
export const LEDGER_TABLES = ["runtime_epoch", "session_admissions", "worker_executions", "worker_receipts"] as const;

/** Create an empty upstream-shaped database: WAL mode, the tables, the indexes. FTS and the version row are not written here. */
/**
 * Read a state.db without changing it, and return what `fn` returns.
 *
 * Upstream keeps state.db in WAL mode. A read-only connection to a WAL file
 * needs to create the `-shm` file. When it cannot (bun on macOS without a
 * `-wal`, or a directory this process cannot write to), this copies the file
 * and its `-wal` into a new temporary directory, opens the copy read-write
 * (so SQLite can recover the WAL) with `query_only` on, and removes the copy
 * afterwards. The input is never opened read-write: closing such a
 * connection would checkpoint the WAL into the file and remove the WAL.
 */
export function readDbFile<T>(path: string, fn: (db: DatabaseSync) => T): T {
  if (!existsSync(path)) throw new Error(`${path}: no such file`);
  const ro = new DatabaseSync(path, { readOnly: true });
  let opened = false;
  try {
    // Bun opens lazily, so the failure shows at the first statement, not in the constructor.
    ro.prepare("SELECT count(*) FROM sqlite_master").get();
    opened = true;
  } catch (e) {
    if (!(e instanceof Error && /unable to open database file/.test(e.message))) throw e;
  } finally {
    if (!opened) ro.close();
  }
  if (opened) {
    try {
      return fn(ro);
    } finally {
      ro.close();
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), "hermesd-read-"));
  try {
    const copy = join(scratch, "state.db");
    copyFileSync(path, copy);
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy);
    try {
      db.exec("PRAGMA query_only = ON");
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function createUpstreamDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  const ddl = upstreamDdl();
  for (const t of ddl.tables) db.exec(t.sql);
  for (const i of ddl.indexes) db.exec(i.sql);
  return db;
}

/**
 * Make the two FTS5 tables again from the `messages` rows. They are never
 * copied: upstream also rebuilds them on recovery. We use the plain layout of
 * `hermes_state_common.py` (lines 1159 and 1188). Returns false when this
 * SQLite has no FTS5.
 */
export function regenerateFts(db: DatabaseSync): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5( content )");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5( content, tokenize='trigram' )");
  } catch {
    return false;
  }
  db.exec("DELETE FROM messages_fts");
  db.exec("DELETE FROM messages_fts_trigram");
  db.exec("INSERT INTO messages_fts (rowid, content) SELECT id, content FROM messages WHERE content IS NOT NULL");
  db.exec("INSERT INTO messages_fts_trigram (rowid, content) SELECT id, content FROM messages WHERE content IS NOT NULL");
  return true;
}

/** Collapse white space and drop `IF NOT EXISTS`, so that SQLite's stored text can be compared with the file's. */
export function normaliseSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/IF NOT EXISTS /gi, "").trim();
}
