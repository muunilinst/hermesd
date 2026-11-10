import type { Host } from "@hermesd/host";
import { FENCE_DDL, fenceEpoch, num, str, type ActorBehavior } from "@hermesd/runtime";

/**
 * A minimal profile actor, only to test the outbox (D12).
 *
 * It keeps the cross-session search index. It applies each outbox row once,
 * by the row's idempotency key. It refuses a lower epoch from a session. On
 * activation it asks each known session to send its old outbox rows (guide 4.6,
 * "the profile actor reconciles"). The index is a plain table with a LIKE
 * search. It stands in for FTS5.
 */
export class ProfileStub implements ActorBehavior {
  readonly #host: Host;
  readonly #sessionTarget: (id: string) => string;
  readonly #olderThanMs: number;

  constructor(host: Host, opts: { sessionTarget?: (id: string) => string; olderThanMs?: number } = {}) {
    this.#host = host;
    this.#sessionTarget = opts.sessionTarget ?? ((id) => `actor:${id}`);
    this.#olderThanMs = opts.olderThanMs ?? 0;
  }

  async activate(): Promise<void> {
    await this.#host.tx((sql) => {
      sql.exec(FENCE_DDL);
      sql.exec("CREATE TABLE IF NOT EXISTS applied (id TEXT PRIMARY KEY)");
      sql.exec("CREATE TABLE IF NOT EXISTS sessions (session TEXT PRIMARY KEY)");
      sql.exec("CREATE TABLE IF NOT EXISTS search_index (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL)");
    });
    await this.#host.commit();
    void this.reconcile().catch(() => {});
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "index": {
        const session = p.session as string;
        const key = p.idempotencyKey as string;
        await this.#host.tx((sql) => {
          fenceEpoch(sql, session, p.epoch as number);
          if (sql.exec("SELECT 1 AS x FROM applied WHERE id = ?", key).length > 0) return; // applied before
          sql.exec("INSERT INTO applied (id) VALUES (?)", key);
          sql.exec("INSERT INTO search_index (session, seq, text) VALUES (?, ?, ?)", session, p.seq as number, p.text as string);
        });
        await this.#host.commit(); // confirm only when durable
        return { ok: true };
      }
      case "register_session":
        await this.#host.tx((sql) => sql.exec("INSERT OR IGNORE INTO sessions (session) VALUES (?)", p.session as string));
        await this.#host.commit();
        return { ok: true };
      case "session_search": {
        const rows = await this.#host.tx((sql) =>
          sql.exec("SELECT session, seq, text FROM search_index WHERE text LIKE ? ORDER BY id", `%${String(p.query)}%`),
        );
        return rows.map((r) => ({ session: str(r.session), seq: num(r.seq), text: str(r.text) }));
      }
      case "reconcile":
        return { asked: await this.reconcile() };
      default:
        throw new Error(`profile: unknown method ${method}`);
    }
  }

  /** Ask each known session to send the outbox rows that are older than the threshold. */
  async reconcile(): Promise<number> {
    const sessions = await this.#host.tx((sql) => sql.exec("SELECT session FROM sessions"));
    const results = await Promise.allSettled(
      sessions.map((s) => this.#host.sidecar(this.#sessionTarget(str(s.session))).call("flush_outbox", { olderThanMs: this.#olderThanMs })),
    );
    return results.filter((r) => r.status === "fulfilled").length;
  }
}
