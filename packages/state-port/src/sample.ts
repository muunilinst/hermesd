import type { DatabaseSync } from "node:sqlite";
import type { SqlValue } from "@hermesd/host";
import type { Row } from "./image.ts";
import { SCHEMA_VERSION, createUpstreamDb } from "./schema.ts";

/**
 * A small upstream-shaped `state.db` for the migration test. It is built from
 * upstream's DDL with `node:sqlite`. No upstream code ran to make it.
 *
 * - Chain `s1`: one session, 4 messages about a Kubernetes rollout, 2 finished
 *   admissions, one finished cron worker with a receipt.
 * - Chain `s2`: a session that compaction ended, and its child `s2b`. One
 *   finished admission, and one `started` admission (the owner died).
 * - A lease and a compression lock that are still live, a gateway row, and
 *   two `state_meta` keys that mark a generated FTS layout.
 *
 * The ids are chosen so that two actors that go on writing will collide
 * (`s1` ends at message 4 and admission 2; `s2` has 5 to 8 and 3 to 4).
 */

export const SAMPLE_PRINCIPAL = "user-1";
export const SAMPLE_HASH = "sys-hash-1";
export const SAMPLE_START = 1_700_000_000;

function put(db: DatabaseSync, table: string, row: Row): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...(cols.map((c) => row[c]) as SqlValue[] as never[]),
  );
}

function message(id: number, session: string, role: string, content: string, at: number, extra: Row = {}): Row {
  return { id, session_id: session, role, content, timestamp: at, message_uid: `m-${id}`, active: 1, ...extra };
}

export function buildSampleStateDb(path: string): void {
  const db = createUpstreamDb(path);
  db.exec("PRAGMA foreign_keys = OFF");
  const t = SAMPLE_START;
  put(db, "schema_version", { version: SCHEMA_VERSION });
  put(db, "system_prompts", { hash: SAMPLE_HASH, prompt: "You are a helpful agent." });

  const base = { source: "cli", model: "scripted-model", system_prompt_hash: SAMPLE_HASH, system_prompt: "You are a helpful agent." };
  put(db, "sessions", { ...base, id: "s1", title: "Rollout planning", started_at: t, last_activity_at: t + 40, message_count: 4 });
  put(db, "sessions", { ...base, id: "s2", title: "Migration window", started_at: t + 100, ended_at: t + 160, end_reason: "compression", message_count: 2 });
  put(db, "sessions", { ...base, id: "s2b", parent_session_id: "s2", title: "Migration window #2", started_at: t + 160, message_count: 2 });

  put(db, "messages", message(1, "s1", "user", "What is the plan for the kubernetes rollout?", t + 10));
  put(db, "messages", message(2, "s1", "assistant", "Roll out the canary first, then the rest.", t + 20, { finish_reason: "stop" }));
  put(db, "messages", message(3, "s1", "user", "Pause the rollout if errors rise.", t + 30));
  put(db, "messages", message(4, "s1", "assistant", "Understood, the rollout pauses on errors.", t + 40, { finish_reason: "stop" }));
  put(db, "messages", message(5, "s2", "user", "Remember the database migration window is Friday night.", t + 110));
  put(db, "messages", message(6, "s2", "assistant", "Noted: migration window Friday night, no deploys then.", t + 120, { finish_reason: "stop" }));
  put(db, "messages", message(7, "s2b", "user", "[summary] The migration window is Friday night.", t + 165, { _compressed_summary: 1 }));
  put(db, "messages", message(8, "s2b", "assistant", "Ready to continue.", t + 170, { finish_reason: "stop" }));

  put(db, "session_model_usage", { session_id: "s1", model: "scripted-model", api_call_count: 2, input_tokens: 40, output_tokens: 12, first_seen: t + 10, last_seen: t + 40 });

  put(db, "conversation_generations", { source: "telegram", session_key: "chat-1", generation: 3 });
  put(db, "conversation_generations", { source: "cli", session_key: "default", generation: 1 });
  put(db, "state_meta", { key: "profile_label", value: "work" });
  put(db, "state_meta", { key: "fts_storage_version", value: "3" });
  put(db, "state_meta", { key: "fts_trigram_ready", value: "1" });

  // The ledger.
  put(db, "runtime_epoch", { singleton: 1, epoch: 7, instance_id: "gateway-old" });
  const adm = (seq: number, session: string, request: string, status: string, outcome: string | null, epoch: number, generation: number): Row => ({
    seq,
    admission_id: `adm-${seq}`,
    request_id: request,
    principal_id: SAMPLE_PRINCIPAL,
    target_session_id: session,
    lineage_json: "{}",
    payload_json: JSON.stringify({ input: `input of ${request}` }),
    payload_digest: `digest-${seq}`,
    intent: "queue",
    status,
    outcome,
    owner_epoch: epoch,
    generation,
  });
  put(db, "session_admissions", adm(1, "s1", "old-1", "terminal", "completed", 5, 1));
  put(db, "session_admissions", adm(2, "s1", "old-2", "terminal", "completed", 6, 2));
  put(db, "session_admissions", adm(3, "s2", "old-3", "terminal", "completed", 6, 3));
  put(db, "session_admissions", adm(4, "s2b", "old-4", "started", null, 7, 4));
  put(db, "worker_executions", { execution_id: "exec-1", session_id: "s1", kind: "cron", owner_epoch: 6, generation: 1, status: "terminal", adoption_digest: "ad-1", last_sequence: 1 });
  put(db, "worker_receipts", { execution_id: "exec-1", sequence: 1, payload_digest: "pd-1", result_json: '{"ok":true}' });

  // Rows that the port replaces or does not carry.
  put(db, "session_turn_leases", { conversation_id: "s1", holder: "gateway-old", acquired_at: t + 50, expires_at: t + 350 });
  put(db, "compression_locks", { session_id: "s2", holder: "gateway-old", acquired_at: t + 150, expires_at: t + 450 });
  put(db, "gateway_routing", { scope: "", session_key: "chat-1", entry_json: "{}", updated_at: t });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}
