import { DatabaseSync } from "node:sqlite";
import type { Sql, SqlRow, SqlValue } from "@hermesd/host";
import { applyProfileImage, applySessionImage } from "./apply.ts";
import type { StateImage } from "./image.ts";
import type { ActorSource, ActorSources } from "./read-actors.ts";

/**
 * Actors without a platform: one in-memory SQLite database for the profile
 * and one for each session actor. Used by the unit tests and by the
 * `roundtrip` command. The migration test uses the simulator instead.
 */

export interface PlainActors {
  sql: { profile: Sql; sessions: Map<string, Sql> };
  sources: ActorSources;
  close(): void;
}

function over(db: DatabaseSync): { sql: Sql; source: Omit<ActorSource, "epoch"> } {
  const query = (q: string, ...params: SqlValue[]): SqlRow[] => db.prepare(q).all(...(params as never[])).map((r) => ({ ...r })) as SqlRow[];
  return { sql: { exec: query }, source: { query } };
}

/** Put an image into fresh in-memory actors. Every actor gets the epoch `epoch`. */
export function loadPlainActors(image: StateImage, epoch = 1): PlainActors {
  const dbs: DatabaseSync[] = [];
  const open = (): ReturnType<typeof over> => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    return over(db);
  };
  const profile = open();
  applyProfileImage(profile.sql, image);
  const sessions = new Map<string, Sql>();
  const sources: ActorSources = { profile: { ...profile.source, epoch }, sessions: [] };
  for (const s of image.sessions) {
    const a = open();
    applySessionImage(a.sql, s);
    sessions.set(s.actor, a.sql);
    sources.sessions.push({ actor: s.actor, source: { ...a.source, epoch } });
  }
  return { sql: { profile: profile.sql, sessions }, sources, close: () => dbs.forEach((d) => d.close()) };
}
