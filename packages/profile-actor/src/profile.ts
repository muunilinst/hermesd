import type { Host, Sql } from "@hermesd/host";
import { FENCE_DDL, fenceEpoch, num, str, type ActorBehavior } from "@hermesd/runtime";
import { PROFILE_UPSTREAM_DDL, UPSTREAM_SCHEMA_VERSION } from "@hermesd/session-actor";

/**
 * The profile actor (guide 6.4): one per tenant.
 *
 * It holds the config, the cross-session search index, the list of sessions
 * and `conversation_generations`. Session actors feed it only through their
 * outbox. Every outbox call carries an idempotency key. The profile applies
 * each key once and confirms only after the rows are durable. It refuses a
 * lower owner epoch from a session. On activation it asks its sessions to send
 * the outbox rows that are older than a threshold (reconcile).
 *
 * Search uses FTS5 where the platform SQLite has it. Else it falls back to a
 * LIKE scan over the same documents. The documents table is the source of
 * truth, so the FTS index can be regenerated (`rebuild_index`), as upstream
 * regenerates its indexes on recovery.
 */

const SCHEMA_VERSION = UPSTREAM_SCHEMA_VERSION;

export interface ProfileOptions {
  /** The sidecar name of a session actor. */
  sessionTarget?: (id: string) => string;
  /** Reconcile asks for outbox rows older than this. 0 asks for all. */
  olderThanMs?: number;
  /** Do not use FTS5 even if it exists. For tests of the fallback. */
  forceLike?: boolean;
}

export interface SearchHit {
  session: string;
  seq: number;
  role: string;
  text: string;
}

export class ProfileActor implements ActorBehavior {
  readonly #host: Host;
  readonly #sessionTarget: (id: string) => string;
  readonly #olderThanMs: number;
  readonly #forceLike: boolean;
  #fts = false;

  constructor(host: Host, opts: ProfileOptions = {}) {
    this.#host = host;
    this.#sessionTarget = opts.sessionTarget ?? ((id) => `actor:${id}`);
    this.#olderThanMs = opts.olderThanMs ?? 0;
    this.#forceLike = opts.forceLike ?? false;
  }

  async activate(): Promise<void> {
    await this.#host.tx((sql) => {
      sql.exec(FENCE_DDL);
      sql.exec("CREATE TABLE IF NOT EXISTS applied (id TEXT PRIMARY KEY)");
      sql.exec("CREATE TABLE IF NOT EXISTS profile_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      sql.exec(
        `CREATE TABLE IF NOT EXISTS profile_config (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, schema_version INTEGER NOT NULL)`,
      );
      // The session actors that belong to this profile. Reconcile asks them.
      sql.exec("CREATE TABLE IF NOT EXISTS session_actors (actor TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)");
      sql.exec(
        `CREATE TABLE IF NOT EXISTS session_list (
          session_id TEXT PRIMARY KEY, actor TEXT NOT NULL, parent_session_id TEXT, status TEXT NOT NULL,
          title TEXT, message_count INTEGER NOT NULL DEFAULT 0, started_at REAL, last_activity_at REAL,
          schema_version INTEGER NOT NULL)`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS search_docs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, seq INTEGER NOT NULL,
          role TEXT NOT NULL, text TEXT NOT NULL, schema_version INTEGER NOT NULL, UNIQUE (session, seq))`,
      );
      for (const ddl of Object.values(PROFILE_UPSTREAM_DDL)) sql.exec(ddl);
    });
    await this.#host.commit();
    this.#fts = await this.#detectFts();
    void this.reconcile().catch(() => {});
  }

  /** Try to create the FTS5 index. A platform without FTS5 throws, and the profile keeps the LIKE scan. */
  async #detectFts(): Promise<boolean> {
    if (this.#forceLike) return false;
    try {
      await this.#host.tx((sql) =>
        sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(text, tokenize = 'unicode61')"),
      );
      await this.#host.commit();
      return true;
    } catch {
      return false;
    }
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "index":
        return this.#apply(p, (sql) => {
          const r = sql.exec(
            "INSERT OR IGNORE INTO search_docs (session, seq, role, text, schema_version) VALUES (?, ?, ?, ?, ?) RETURNING id",
            str(p.session as string),
            num(p.seq as number),
            str(p.role as string),
            str(p.text as string),
            SCHEMA_VERSION,
          );
          if (r[0] && this.#fts) sql.exec("INSERT INTO search_fts (rowid, text) VALUES (?, ?)", num(r[0].id), str(p.text as string));
        });
      case "session_upsert":
        return this.#apply(p, (sql) => {
          sql.exec(
            `INSERT INTO session_list (session_id, actor, parent_session_id, status, title, message_count, started_at, last_activity_at, schema_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (session_id) DO UPDATE SET status = excluded.status, title = COALESCE(excluded.title, title),
               message_count = MAX(message_count, excluded.message_count),
               last_activity_at = MAX(COALESCE(last_activity_at, 0), COALESCE(excluded.last_activity_at, 0))`,
            str(p.sessionId as string),
            str(p.session as string),
            (p.parent as string | undefined) ?? null,
            str((p.status as string | undefined) ?? "open"),
            (p.title as string | null | undefined) ?? null,
            (p.messageCount as number | undefined) ?? 0,
            (p.startedAt as number | undefined) ?? null,
            (p.lastActivityAt as number | undefined) ?? null,
            SCHEMA_VERSION,
          );
        });
      case "register_session":
        await this.#host.tx((sql) =>
          sql.exec("INSERT OR IGNORE INTO session_actors (actor, schema_version) VALUES (?, ?)", str(p.session as string), SCHEMA_VERSION),
        );
        await this.#host.commit();
        return { ok: true };
      case "session_search":
        return this.search(str(p.query as string), (p.limit as number | undefined) ?? 20);
      case "list_sessions": {
        const rows = await this.#host.tx((sql) =>
          sql.exec("SELECT session_id, actor, parent_session_id, status, title, message_count, last_activity_at FROM session_list ORDER BY last_activity_at DESC, session_id"),
        );
        return rows.map((r) => ({
          sessionId: str(r.session_id),
          actor: str(r.actor),
          parent: (r.parent_session_id as string | null) ?? null,
          status: str(r.status),
          title: (r.title as string | null) ?? null,
          messageCount: num(r.message_count),
        }));
      }
      case "generation_bump":
        return this.#bump(str(p.source as string), str(p.sessionKey as string));
      case "generation_get": {
        const r = await this.#host.tx((sql) =>
          sql.exec("SELECT generation FROM conversation_generations WHERE source = ? AND session_key = ?", str(p.source as string), str(p.sessionKey as string))[0],
        );
        return { generation: r ? num(r.generation) : 0 };
      }
      case "config_set":
        await this.#host.tx((sql) =>
          sql.exec("INSERT OR REPLACE INTO profile_config (key, value, schema_version) VALUES (?, ?, ?)", str(p.key as string), JSON.stringify(p.value ?? null), SCHEMA_VERSION),
        );
        await this.#host.commit();
        return { ok: true };
      case "config_get": {
        const r = await this.#host.tx((sql) => sql.exec("SELECT value FROM profile_config WHERE key = ?", str(p.key as string))[0]);
        return { value: r ? (JSON.parse(str(r.value)) as unknown) : null };
      }
      case "rebuild_index":
        return { rebuilt: await this.rebuildIndex() };
      case "status":
        return { fts: this.#fts };
      case "reconcile":
        return { asked: await this.reconcile() };
      default:
        throw new Error(`profile: unknown method ${method}`);
    }
  }

  /** Apply one outbox call once. Confirm only after the commit. */
  async #apply(p: Record<string, unknown>, fn: (sql: Sql) => void): Promise<{ ok: true; duplicate?: true }> {
    const key = str(p.idempotencyKey as string);
    const duplicate = await this.#host.tx((sql) => {
      fenceEpoch(sql, str(p.session as string), num(p.epoch as number));
      // A session that sends anything is one of ours: reconcile will ask it later.
      sql.exec("INSERT OR IGNORE INTO session_actors (actor, schema_version) VALUES (?, ?)", str(p.session as string), SCHEMA_VERSION);
      if (sql.exec("SELECT 1 AS x FROM applied WHERE id = ?", key).length > 0) return true;
      sql.exec("INSERT INTO applied (id) VALUES (?)", key);
      fn(sql);
      return false;
    });
    await this.#host.commit();
    return duplicate ? { ok: true, duplicate: true } : { ok: true };
  }

  async #bump(source: string, sessionKey: string): Promise<{ generation: number }> {
    const gen = await this.#host.tx((sql) => {
      sql.exec(
        "INSERT INTO conversation_generations (source, session_key, generation) VALUES (?, ?, 1) ON CONFLICT (source, session_key) DO UPDATE SET generation = generation + 1",
        source,
        sessionKey,
      );
      return num(sql.exec("SELECT generation FROM conversation_generations WHERE source = ? AND session_key = ?", source, sessionKey)[0]!.generation);
    });
    await this.#host.commit();
    return { generation: gen };
  }

  /** Search the documents of all sessions. Words are joined with AND. */
  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return [];
    const rows = await this.#host.tx((sql) => {
      if (this.#fts) {
        const match = words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" ");
        return sql.exec(
          `SELECT d.session, d.seq, d.role, d.text FROM search_fts f JOIN search_docs d ON d.id = f.rowid
           WHERE search_fts MATCH ? ORDER BY d.id LIMIT ?`,
          match,
          limit,
        );
      }
      const like = words.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
      return sql.exec(
        `SELECT session, seq, role, text FROM search_docs WHERE ${like} ORDER BY id LIMIT ?`,
        ...words.map((w) => `%${w.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`),
        limit,
      );
    });
    return rows.map((r) => ({ session: str(r.session), seq: num(r.seq), role: str(r.role), text: str(r.text) }));
  }

  /** Regenerate the FTS index from the documents. */
  async rebuildIndex(): Promise<number> {
    if (!this.#fts) return 0;
    const n = await this.#host.tx((sql) => {
      sql.exec("DELETE FROM search_fts");
      sql.exec("INSERT INTO search_fts (rowid, text) SELECT id, text FROM search_docs");
      return num(sql.exec("SELECT COUNT(*) AS n FROM search_docs")[0]!.n);
    });
    await this.#host.commit();
    return n;
  }

  /** Ask each known session actor to send the outbox rows that are older than the threshold. */
  async reconcile(): Promise<number> {
    const actors = await this.#host.tx((sql) => sql.exec("SELECT actor FROM session_actors"));
    const results = await Promise.allSettled(
      actors.map((a) => this.#host.sidecar(this.#sessionTarget(str(a.actor))).call("flush_outbox", { olderThanMs: this.#olderThanMs })),
    );
    return results.filter((r) => r.status === "fulfilled").length;
  }
}
