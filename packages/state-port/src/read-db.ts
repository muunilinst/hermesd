import { DatabaseSync } from "node:sqlite";
import type { SqlValue } from "@hermesd/host";
import { emptySession, type Dropped, type Row, type SessionImage, type StateImage } from "./image.ts";
import { SCHEMA_VERSION, openReadOnly } from "./schema.ts";

/**
 * Import: split one profile's upstream `state.db` into a profile image and
 * one session image for each chain of sessions (guide 6.4).
 *
 * The owners:
 * - profile actor: `conversation_generations`, `state_meta`, `schema_version`;
 * - session actor: `system_prompts`, `sessions`, `messages`,
 *   `session_model_usage`, and the ledger rows of its sessions;
 * - nobody (not carried yet, counted in `dropped`): see `NOT_CARRIED`.
 *
 * A chain is a set of sessions joined by `parent_session_id`, which is what
 * compaction makes. The actor of a chain is keyed by the id of its first
 * session.
 */

export interface ImportOptions {
  /**
   * `keep` reads the four ledger tables, as a full backup restore does.
   * `exclude` leaves them out, as `hermes sessions recover` does. Default `keep`.
   */
  ledger?: "keep" | "exclude";
}

export interface ImportReport {
  ledger: "keep" | "exclude";
  /** Tables the port does not carry, and how many rows each had. Only tables with rows are listed. */
  dropped: Dropped;
  /** `started` admissions that became `unknown`, as upstream does at the next owner start. */
  startedToUnknown: number;
  /** State meta rows left out because they only mark a generated FTS layout. */
  metaDropped: string[];
}

/**
 * Tables that exist upstream and are not carried into the actors yet. The
 * reason is in NOTES.md. `session_turn_leases` and `compression_locks` are
 * replaced by actor ownership (guide 2.4), so they are dropped on purpose.
 */
export const NOT_CARRIED = [
  "session_turn_leases",
  "compression_locks",
  "async_delegations",
  "delivery_obligations",
  "gateway_routing",
  "gateway_hygiene_state",
  "gateway_heartbeats",
  "telegram_dm_topic_bindings",
  "telegram_dm_topic_mode",
] as const;

const LEDGER = ["runtime_epoch", "session_admissions", "worker_executions", "worker_receipts"] as const;

/** A `state_meta` key that only marks a generated FTS layout. Upstream also drops these on recovery (`_GENERATED_META_KEYS`). */
const GENERATED_META = /fts|trigram/i;

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table') AND name = ?").get(name) !== undefined;
}

function all(db: DatabaseSync, sql: string, ...params: SqlValue[]): Row[] {
  return (db.prepare(sql).all(...(params as never[])) as Row[]).map((r) => ({ ...r }));
}

function count(db: DatabaseSync, table: string): number {
  if (!tableExists(db, table)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

/** Group sessions into chains. Returns the session ids of each chain, oldest first, keyed by the first session. */
function chains(sessions: Row[]): Map<string, Row[]> {
  const byId = new Map(sessions.map((s) => [String(s.id), s]));
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    for (;;) {
      seen.add(cur);
      const parent = byId.get(cur)?.parent_session_id;
      if (typeof parent !== "string" || !byId.has(parent) || seen.has(parent)) return cur;
      cur = parent;
    }
  };
  const out = new Map<string, Row[]>();
  for (const s of sessions) {
    const root = rootOf(String(s.id));
    const list = out.get(root) ?? [];
    list.push(s);
    out.set(root, list);
  }
  for (const list of out.values()) list.sort((a, b) => Number(a.started_at) - Number(b.started_at) || String(a.id).localeCompare(String(b.id)));
  return out;
}

/** The session that the actor appends to: the newest session that no other session has as its parent. */
function currentOf(list: Row[], root: string): string {
  const parents = new Set(list.map((s) => s.parent_session_id).filter((p): p is string => typeof p === "string"));
  const leaves = list.filter((s) => !parents.has(String(s.id)));
  const newest = leaves.sort((a, b) => Number(b.started_at) - Number(a.started_at) || String(b.id).localeCompare(String(a.id)))[0];
  return newest ? String(newest.id) : root;
}

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

export function readStateDb(path: string, options: ImportOptions = {}): { image: StateImage; report: ImportReport } {
  const ledger = options.ledger ?? "keep";
  const db = openReadOnly(path);
  try {
    if (!tableExists(db, "schema_version")) throw new Error(`${path}: no schema_version table, so this is not a Hermes state.db`);
    const schema = all(db, "SELECT version FROM schema_version");
    const version = Math.max(0, ...schema.map((r) => Number(r.version)));
    if (version !== SCHEMA_VERSION) throw new Error(`${path}: schema version ${version}, this port reads ${SCHEMA_VERSION}`);

    const dropped: Dropped = {};
    for (const t of NOT_CARRIED) if (count(db, t) > 0) dropped[t] = count(db, t);
    if (ledger === "exclude") for (const t of LEDGER) if (count(db, t) > 0) dropped[t] = count(db, t);

    const meta = tableExists(db, "state_meta") ? all(db, "SELECT key, value FROM state_meta ORDER BY key") : [];
    const metaDropped = meta.filter((r) => GENERATED_META.test(String(r.key))).map((r) => String(r.key));
    const epochRow = ledger === "keep" && tableExists(db, "runtime_epoch") ? all(db, "SELECT epoch FROM runtime_epoch")[0] : undefined;

    const image: StateImage = {
      profile: {
        conversation_generations: tableExists(db, "conversation_generations")
          ? all(db, "SELECT source, session_key, generation FROM conversation_generations ORDER BY source, session_key")
          : [],
        state_meta: meta.filter((r) => !GENERATED_META.test(String(r.key))),
        schema_version: schema,
        epoch: 0,
        upstreamEpoch: epochRow ? Number(epochRow.epoch) : null,
      },
      sessions: [],
    };

    const prompts = new Map(all(db, "SELECT hash, prompt FROM system_prompts").map((p) => [String(p.hash), p]));
    const usedPrompts = new Set<string>();
    let startedToUnknown = 0;

    for (const [root, list] of chains(all(db, "SELECT * FROM sessions"))) {
      const ids = list.map((s) => String(s.id));
      const inIds = `(${marks(ids.length)})`;
      const s: SessionImage = emptySession(root, currentOf(list, root));
      s.sessions = list;
      for (const row of list) {
        const h = row.system_prompt_hash;
        if (typeof h === "string" && prompts.has(h)) {
          usedPrompts.add(h);
          if (!s.system_prompts.some((p) => p.hash === h)) s.system_prompts.push(prompts.get(h)!);
        }
      }
      s.messages = all(db, `SELECT * FROM messages WHERE session_id IN ${inIds} ORDER BY id`, ...ids);
      s.session_model_usage = all(db, `SELECT * FROM session_model_usage WHERE session_id IN ${inIds}`, ...ids);
      if (ledger === "keep") {
        if (tableExists(db, "session_admissions")) {
          s.session_admissions = all(db, `SELECT * FROM session_admissions WHERE target_session_id IN ${inIds} ORDER BY seq`, ...ids).map((r) => {
            // Upstream marks a started input unknown at the next owner start and never replays it.
            // Importing is an owner start, so the same rule applies here.
            if (r.status !== "started") return r;
            startedToUnknown += 1;
            return { ...r, status: "unknown" };
          });
        }
        if (tableExists(db, "worker_executions")) {
          s.worker_executions = all(db, `SELECT * FROM worker_executions WHERE session_id IN ${inIds} ORDER BY execution_id`, ...ids);
          const execs = s.worker_executions.map((e) => String(e.execution_id));
          if (execs.length > 0 && tableExists(db, "worker_receipts")) {
            s.worker_receipts = all(db, `SELECT * FROM worker_receipts WHERE execution_id IN (${marks(execs.length)}) ORDER BY execution_id, sequence`, ...execs);
          }
        }
      }
      image.sessions.push(s);
    }
    image.sessions.sort((a, b) => a.actor.localeCompare(b.actor));

    // A prompt that no session uses still belongs to the file. The first actor keeps it.
    const first = image.sessions[0];
    if (first) for (const [hash, row] of prompts) if (!usedPrompts.has(hash)) first.system_prompts.push(row);
    return { image, report: { ledger, dropped, startedToUnknown, metaDropped } };
  } finally {
    db.close();
  }
}
