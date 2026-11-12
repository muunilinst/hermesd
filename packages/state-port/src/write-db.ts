import { randomUUID } from "node:crypto";
import { existsSync, linkSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { SqlValue } from "@hermesd/host";
import { epochFloor } from "./apply.ts";
import type { Row, StateImage } from "./image.ts";
import { SCHEMA_VERSION, createUpstreamDb, regenerateFts } from "./schema.ts";

/**
 * Export: write an image into a fresh upstream-shaped `state.db`.
 *
 * The rules (guide 2.4, 6.3, 6.4; `contracts/upstream-recovery.md`):
 *
 * - `full` keeps the four ledger tables (`runtime_epoch`, `session_admissions`,
 *   `worker_executions`, `worker_receipts`). `partial` leaves them out, as
 *   `hermes sessions recover` does: "a partial ledger could replay started
 *   effects or adopt another owner's workers".
 * - An in-flight turn is a `started` admission in a full export. Upstream then
 *   reconciles it as `unknown` at the next owner start and does not replay it.
 *   The port itself would resume it; this is the one place where it differs on
 *   purpose. A partial export has no admissions, so the turn is not in the file.
 * - `session_turn_leases` and `compression_locks` are written as expired. They
 *   are written in both modes. Upstream's recovery copies `compression_locks`
 *   as it finds them (finding F3), so a partial export is not identical there.
 * - `conversation_generations` is written in both modes. Upstream's recovery
 *   drops it (finding F2); the port never collects it, so a loss would reset
 *   the generation of a peer.
 * - `runtime_epoch` of a full export is at least the highest owner epoch of
 *   any actor (the epoch floor, as `_restore_epoch_source` keeps one).
 * - The FTS tables are made again from the messages. They are never copied.
 */

export type ExportMode = "full" | "partial";

export interface ExportOptions {
  mode: ExportMode;
  /** The time of the export, in milliseconds. Expired leases and locks are placed before it. */
  now: number;
}

export interface ExportReport {
  mode: ExportMode;
  /** The value written to `runtime_epoch`, or null in a partial export. */
  epoch: number | null;
  /** Actors whose message ids or admission numbers were given new numbers because two actors used the same one. */
  renumbered: { messages: string[]; admissions: string[] };
  /** Session rows that were made so that a queued admission has its session. */
  stubSessions: string[];
  fts: boolean;
  rows: Record<string, number>;
}

const INSTANCE_ID = "hermesd-port-export";

function insert(db: DatabaseSync, table: string, rows: Row[]): void {
  for (const r of rows) {
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
      ...(cols.map((c) => r[c]) as SqlValue[] as never[]),
    );
  }
}

/**
 * Two actors number their rows on their own, so the same id can occur twice.
 * Keep the ids when they are free. If an actor collides, give all its rows new
 * ids above everything used so far, in the old order, so that the order inside
 * each session stays the same.
 */
function claim(used: Set<number>, rows: Row[], key: string): boolean {
  const ids = rows.map((r) => Number(r[key]));
  const collides = ids.some((i) => used.has(i));
  if (collides) {
    let next = 1;
    for (const u of used) next = Math.max(next, u + 1);
    for (const i of ids) next = Math.max(next, i + 1);
    for (const r of rows) {
      r[key] = next;
      used.add(next);
      next += 1;
    }
  } else {
    for (const i of ids) used.add(i);
  }
  return collides;
}

export function writeStateDb(path: string, image: StateImage, options: ExportOptions): ExportReport {
  if (existsSync(path)) throw new Error(`${path} exists; an export never overwrites`);
  const full = options.mode === "full";
  const nowSec = options.now / 1000;
  // Build in a file of our own, then link it into place: the link fails if another export got
  // there first, and a failure only ever removes our own file.
  const tmp = `${path}.${randomUUID()}.tmp`;
  const db = createUpstreamDb(tmp);
  let open = true;
  const report: ExportReport = {
    mode: options.mode,
    epoch: null,
    renumbered: { messages: [], admissions: [] },
    stubSessions: [],
    fts: false,
    rows: {},
  };
  const count = (table: string, n: number): void => {
    report.rows[table] = (report.rows[table] ?? 0) + n;
  };
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");

    insert(db, "schema_version", [{ version: SCHEMA_VERSION }]);
    insert(db, "state_meta", image.profile.state_meta);
    insert(db, "conversation_generations", image.profile.conversation_generations);
    count("conversation_generations", image.profile.conversation_generations.length);

    const usedMessages = new Set<number>();
    const usedAdmissions = new Set<number>();
    const sessionIds = new Set<string>();
    const prompts = new Map<string, string>();

    for (const s of image.sessions) {
      for (const p of s.system_prompts) {
        const hash = String(p.hash);
        const prev = prompts.get(hash);
        if (prev !== undefined && prev !== p.prompt) throw new Error(`two different system prompts have the hash ${hash}`);
        if (prev === undefined) {
          prompts.set(hash, String(p.prompt));
          insert(db, "system_prompts", [p]);
          count("system_prompts", 1);
        }
      }
      for (const row of s.sessions) {
        const id = String(row.id);
        if (sessionIds.has(id)) throw new Error(`session ${id} is in two actors`);
        sessionIds.add(id);
      }
      insert(db, "sessions", s.sessions);
      count("sessions", s.sessions.length);

      const messages = s.messages.map((m) => ({ ...m }));
      if (claim(usedMessages, messages, "id")) report.renumbered.messages.push(s.actor);
      insert(db, "messages", messages);
      count("messages", messages.length);

      insert(db, "session_model_usage", s.session_model_usage);
      count("session_model_usage", s.session_model_usage.length);

      if (full) {
        const admissions = s.session_admissions.map((a) => ({ ...a }));
        if (claim(usedAdmissions, admissions, "seq")) report.renumbered.admissions.push(s.actor);
        // Upstream's foreign key: every admission has its session. A queued input can come before the first turn made the row.
        for (const a of admissions) {
          const target = String(a.target_session_id);
          if (!sessionIds.has(target)) {
            insert(db, "sessions", [{ id: target, source: "teenytiny", started_at: nowSec }]);
            sessionIds.add(target);
            report.stubSessions.push(target);
            count("sessions", 1);
          }
        }
        insert(db, "session_admissions", admissions);
        count("session_admissions", admissions.length);
        insert(db, "worker_executions", s.worker_executions);
        insert(db, "worker_receipts", s.worker_receipts);
        count("worker_executions", s.worker_executions.length);
        count("worker_receipts", s.worker_receipts.length);
      }

      // Expired, never live: the port has no lease. The holder says where the row came from.
      const expires = nowSec - 1;
      const leased = new Set<string>();
      for (const t of s.openTurns) {
        if (leased.has(t.conversation_id)) continue;
        leased.add(t.conversation_id);
        insert(db, "session_turn_leases", [{ conversation_id: t.conversation_id, holder: `hermesd-port:${s.actor}`, acquired_at: Math.min(t.acquired_at, expires), expires_at: expires }]);
        count("session_turn_leases", 1);
      }
      const locked = new Set<string>();
      for (const c of s.openCompactions) {
        if (locked.has(c.session_id)) continue;
        locked.add(c.session_id);
        const acquired = c.acquired_at > 0 ? Math.min(c.acquired_at, expires) : expires;
        insert(db, "compression_locks", [{ session_id: c.session_id, holder: `hermesd-port:${s.actor}`, acquired_at: acquired, expires_at: expires }]);
        count("compression_locks", 1);
      }
    }

    if (full) {
      report.epoch = epochFloor(image);
      insert(db, "runtime_epoch", [{ singleton: 1, epoch: report.epoch, instance_id: INSTANCE_ID }]);
      count("runtime_epoch", 1);
    }
    db.exec("COMMIT");

    report.fts = regenerateFts(db);
    const fk = db.prepare("PRAGMA foreign_key_check").all();
    if (fk.length > 0) throw new Error(`the export breaks a foreign key: ${JSON.stringify(fk[0])}`);
    const ok = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (ok.integrity_check !== "ok") throw new Error(`integrity check: ${ok.integrity_check}`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    open = false;
    try {
      linkSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path} exists; an export never overwrites`);
      throw err;
    }
  } catch (err) {
    if (open) db.close();
    throw err;
  } finally {
    // Leave no half-made file behind.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(tmp + suffix, { force: true });
  }
  return report;
}
