import type { SqlValue } from "@hermesd/host";

/** One row: column name to value. Columns are upstream's. */
export type Row = Record<string, SqlValue>;

/**
 * The rows of one profile, split by owner (guide 6.4). It is the common shape
 * of both directions: an upstream `state.db` is read into an image, and the
 * actors are read into an image. An image can be written to the actors or to
 * a `state.db`.
 */
export interface StateImage {
  profile: ProfileImage;
  sessions: SessionImage[];
}

/** What the profile actor holds of the upstream tables. */
export interface ProfileImage {
  /** Never collected (guide 2.4). Carried in every export. */
  conversation_generations: Row[];
  state_meta: Row[];
  schema_version: Row[];
  /** The owner epoch of the profile actor (`Host.epoch()`). 0 for an image read from a file. */
  epoch: number;
  /** The `runtime_epoch.epoch` of the file this image came from, or null. Part of the epoch floor. */
  upstreamEpoch: number | null;
}

/** What one session actor holds: one chain of sessions (a session and the children that compaction made). */
export interface SessionImage {
  /** The key of the actor. It is the id of the first session of the chain. */
  actor: string;
  /** The session that the actor appends to now: the newest leaf of the chain. */
  currentSession: string;
  /** The owner epoch of the actor (`Host.epoch()`). 0 for an image read from a file. */
  epoch: number;
  system_prompts: Row[];
  sessions: Row[];
  messages: Row[];
  session_model_usage: Row[];
  /** Ledger tables. Empty in a partial image. */
  session_admissions: Row[];
  worker_executions: Row[];
  worker_receipts: Row[];
  /** From live actors only: a turn is open, so upstream would hold a lease. Seconds since the epoch. */
  openTurns: Array<{ conversation_id: string; acquired_at: number }>;
  /** From live actors only: a compaction has started and not finished. */
  openCompactions: Array<{ session_id: string; acquired_at: number }>;
}

export const SESSION_TABLES = ["system_prompts", "sessions", "messages", "session_model_usage"] as const;
export const SESSION_LEDGER_TABLES = ["session_admissions", "worker_executions", "worker_receipts"] as const;

/** Upstream tables that the port does not carry yet, with the number of rows that were in the file. */
export type Dropped = Record<string, number>;

export function emptySession(actor: string, currentSession: string): SessionImage {
  return {
    actor,
    currentSession,
    epoch: 0,
    system_prompts: [],
    sessions: [],
    messages: [],
    session_model_usage: [],
    session_admissions: [],
    worker_executions: [],
    worker_receipts: [],
    openTurns: [],
    openCompactions: [],
  };
}
