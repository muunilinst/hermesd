import type { Row, SessionImage, StateImage } from "./image.ts";

/**
 * A form of an image for comparing two images. It drops what may differ
 * without a change of meaning:
 *
 * - message ids and admission numbers, because an export may give new ones
 *   when two actors used the same one (rows are kept in their old order);
 * - owner epochs of the actors, and the open turns and compactions, which
 *   exist only in live actors;
 * - the epoch of the file the image came from.
 *
 * Two images that have the same canonical form hold the same rows.
 */
export function canonicalImage(image: StateImage, options: { ledger?: boolean } = {}): unknown {
  const ledger = options.ledger ?? true;
  const strip = (rows: Row[], key: string): Row[] => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key)));
  const session = (s: SessionImage): unknown => ({
    actor: s.actor,
    currentSession: s.currentSession,
    system_prompts: [...s.system_prompts].sort((a, b) => String(a.hash).localeCompare(String(b.hash))),
    sessions: [...s.sessions].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    messages: strip(s.messages, "id"),
    session_model_usage: s.session_model_usage,
    ...(ledger
      ? { session_admissions: strip(s.session_admissions, "seq"), worker_executions: s.worker_executions, worker_receipts: s.worker_receipts }
      : {}),
  });
  return {
    profile: {
      conversation_generations: image.profile.conversation_generations,
      state_meta: image.profile.state_meta,
      schema_version: image.profile.schema_version,
    },
    sessions: [...image.sessions].sort((a, b) => a.actor.localeCompare(b.actor)).map(session),
  };
}
