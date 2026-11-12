import type { SqlRow, SqlValue } from "@hermesd/host";
import { emptySession, type Row, type SessionImage, type StateImage } from "./image.ts";

/**
 * Read the actors into an image. This is the first half of an export.
 *
 * An actor is read through a function that runs a query on its storage. A
 * test reads through the simulator. A host adapter reads through its own
 * storage (a Durable Object cell, a Rivet actor). `epoch` is the owner epoch
 * that the actor ran with (`Host.epoch()`).
 */

export interface ActorSource {
  query(sql: string, ...params: SqlValue[]): SqlRow[];
  epoch: number;
}

export interface ActorSources {
  profile: ActorSource;
  /** One entry for each session actor, keyed as the actor is keyed. */
  sessions: Array<{ actor: string; source: ActorSource }>;
}

const plain = (rows: SqlRow[]): Row[] => rows.map((r) => ({ ...r }));

function has(src: ActorSource, table: string): boolean {
  return src.query("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", table).length > 0;
}

function all(src: ActorSource, table: string, order: string): Row[] {
  return has(src, table) ? plain(src.query(`SELECT * FROM ${table} ORDER BY ${order}`)) : [];
}

export function readActors(actors: ActorSources): StateImage {
  const p = actors.profile;
  const upstream = has(p, "profile_meta") ? p.query("SELECT value FROM profile_meta WHERE key = 'upstream_runtime_epoch'")[0] : undefined;
  const image: StateImage = {
    profile: {
      conversation_generations: all(p, "conversation_generations", "source, session_key"),
      state_meta: all(p, "state_meta", "key"),
      schema_version: all(p, "schema_version", "version"),
      epoch: p.epoch,
      upstreamEpoch: upstream ? Number(upstream.value) : null,
    },
    sessions: [],
  };
  for (const { actor, source: s } of actors.sessions) {
    const current = has(s, "sa_meta") ? s.query("SELECT value FROM sa_meta WHERE key = 'current_session'")[0] : undefined;
    const currentSession = typeof current?.value === "string" ? current.value : actor;
    const img: SessionImage = emptySession(actor, currentSession);
    img.epoch = s.epoch;
    img.system_prompts = all(s, "system_prompts", "hash");
    img.sessions = all(s, "sessions", "started_at, id");
    img.messages = all(s, "messages", "id");
    img.session_model_usage = all(s, "session_model_usage", "session_id, model, billing_provider, billing_base_url, billing_mode, task");
    img.session_admissions = all(s, "session_admissions", "seq");
    img.worker_executions = all(s, "worker_executions", "execution_id");
    img.worker_receipts = all(s, "worker_receipts", "execution_id, sequence");
    if (has(s, "turns")) {
      for (const t of s.query("SELECT started_at FROM turns WHERE status = 'open'")) {
        img.openTurns.push({ conversation_id: currentSession, acquired_at: Number(t.started_at) / 1000 });
      }
    }
    if (has(s, "compaction_link")) {
      for (const l of s.query("SELECT parent_id FROM compaction_link WHERE status = 'started'")) {
        img.openCompactions.push({ session_id: String(l.parent_id), acquired_at: 0 });
      }
    }
    image.sessions.push(img);
  }
  return image;
}
