import type { Sql } from "@hermesd/host";
import { applyProfileSchema } from "@hermesd/profile-actor";
import { SESSION_DDL, num } from "@hermesd/runtime";
import { applySessionSchema, setCurrentSessionId } from "@hermesd/session-actor";
import type { Row, SessionImage, StateImage } from "./image.ts";
import { SCHEMA_VERSION } from "./schema.ts";

/**
 * Write an image into the actors. The caller gives one `Sql` for each actor
 * (inside a `Host.tx`, or over the storage of a test). The actors must be
 * empty: an import is not a merge.
 *
 * After this, call `rebuild_index` on the profile actor. The search documents
 * are written here, and the FTS index is made again from them, as upstream
 * makes its indexes again on recovery.
 *
 * `Host.epoch()` is owned by the platform and is not set here. The image
 * keeps the epoch of the file in `profile.upstreamEpoch`. The profile actor
 * stores it as `upstream_runtime_epoch` so that an export can keep the epoch
 * floor (`upstream-recovery.md`, finding F4). A host adapter should also raise
 * its owner epochs to at least `epochFloor(image)`.
 */

/** Insert rows into a table. Columns are the keys of each row. */
export function insertRows(sql: Sql, table: string, rows: Row[], verb = "INSERT"): void {
  for (const r of rows) {
    const cols = Object.keys(r);
    sql.exec(`${verb} INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => r[c]!));
  }
}

function isEmpty(sql: Sql, table: string): boolean {
  return num(sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n) === 0;
}

/** Sessions with their parents first, so that the foreign key holds. */
function parentsFirst(sessions: Row[]): Row[] {
  const byId = new Map(sessions.map((s) => [String(s.id), s]));
  const done = new Set<string>();
  const out: Row[] = [];
  const visit = (s: Row, depth: number): void => {
    const id = String(s.id);
    if (done.has(id) || depth > sessions.length) return;
    const parent = typeof s.parent_session_id === "string" ? byId.get(s.parent_session_id) : undefined;
    if (parent) visit(parent, depth + 1);
    done.add(id);
    out.push(s);
  };
  for (const s of sessions) visit(s, 0);
  return out;
}

export function applySessionImage(sql: Sql, img: SessionImage): void {
  applySessionSchema(sql);
  for (const ddl of SESSION_DDL) sql.exec(ddl);
  if (!isEmpty(sql, "sessions")) throw new Error(`session actor ${img.actor} is not empty`);
  insertRows(sql, "system_prompts", img.system_prompts);
  insertRows(sql, "sessions", parentsFirst(img.sessions));
  insertRows(sql, "messages", img.messages);
  insertRows(sql, "session_model_usage", img.session_model_usage);
  insertRows(sql, "worker_executions", img.worker_executions);
  insertRows(sql, "worker_receipts", img.worker_receipts);
  insertRows(sql, "session_admissions", img.session_admissions);
  // The side table of the runtime. An imported admission has no turn and no result text.
  for (const a of img.session_admissions) {
    sql.exec(
      "INSERT INTO rt_admission_port (seq, turn_id, result, received_epoch, created_at, updated_at) VALUES (?, NULL, NULL, ?, 0, 0)",
      a.seq!,
      typeof a.owner_epoch === "number" ? a.owner_epoch : 0,
    );
  }
  setCurrentSessionId(sql, img.currentSession);
}

const INDEXED_VERSION = SCHEMA_VERSION;

export function applyProfileImage(sql: Sql, image: StateImage): void {
  applyProfileSchema(sql);
  const p = image.profile;
  insertRows(sql, "conversation_generations", p.conversation_generations, "INSERT OR REPLACE");
  insertRows(sql, "state_meta", p.state_meta, "INSERT OR REPLACE");
  if (isEmpty(sql, "schema_version")) insertRows(sql, "schema_version", p.schema_version);
  if (p.upstreamEpoch !== null) {
    sql.exec("INSERT OR REPLACE INTO profile_meta (key, value) VALUES ('upstream_runtime_epoch', ?)", String(p.upstreamEpoch));
  }
  // The derived parts: the list of sessions, the actors to reconcile with, and the search documents.
  for (const s of image.sessions) {
    sql.exec("INSERT OR IGNORE INTO session_actors (actor, schema_version) VALUES (?, ?)", s.actor, INDEXED_VERSION);
    for (const row of s.sessions) {
      sql.exec(
        `INSERT OR IGNORE INTO session_list (session_id, actor, parent_session_id, status, title, message_count, started_at, last_activity_at, schema_version)
         VALUES (?, ?, ?, 'imported', ?, ?, ?, ?, ?)`,
        row.id!,
        s.actor,
        row.parent_session_id ?? null,
        row.title ?? null,
        row.message_count ?? 0,
        row.started_at ?? null,
        row.last_activity_at ?? null,
        INDEXED_VERSION,
      );
    }
    for (const m of s.messages) {
      if (typeof m.content !== "string" || m.content === "") continue;
      sql.exec(
        "INSERT OR IGNORE INTO search_docs (session, seq, role, text, schema_version) VALUES (?, ?, ?, ?, ?)",
        s.actor,
        m.id!,
        m.role!,
        m.content,
        INDEXED_VERSION,
      );
    }
  }
}

/**
 * The lowest epoch an export may write into `runtime_epoch` (the "epoch
 * floor"): the highest owner epoch of any actor, of any admission row, and the
 * epoch of the file the image came from. Upstream's `_restore_epoch_source`
 * keeps a floor in the same way so that an older epoch is never used again.
 * At least 1, because upstream has `CHECK (epoch > 0)`.
 */
export function epochFloor(image: StateImage): number {
  let top = Math.max(1, image.profile.epoch, image.profile.upstreamEpoch ?? 0);
  for (const s of image.sessions) {
    top = Math.max(top, s.epoch);
    for (const a of s.session_admissions) if (typeof a.owner_epoch === "number") top = Math.max(top, a.owner_epoch);
    for (const w of s.worker_executions) if (typeof w.owner_epoch === "number") top = Math.max(top, w.owner_epoch);
  }
  return top;
}
