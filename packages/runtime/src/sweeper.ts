import type { Host } from "@hermesd/host";
import { resolveConfig, type ActorBehavior, type Clock, type RuntimeConfig } from "./types.ts";
import { FENCE_DDL, fenceEpoch, str } from "./util.ts";

const DDL = [
  FENCE_DDL,
  `CREATE TABLE IF NOT EXISTS sessions (
    session TEXT PRIMARY KEY,
    registered_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS open_turns (
    session TEXT NOT NULL,
    turn TEXT NOT NULL,
    horizon INTEGER NOT NULL,
    PRIMARY KEY (session, turn)
  )`,
  `CREATE TABLE IF NOT EXISTS applied (id TEXT PRIMARY KEY)`,
];

/** Calls the sweeper accepts. `session` and `epoch` are always set. */
export interface SweeperCall {
  session: string;
  epoch: number;
  turn?: string;
  horizon?: number;
  idempotencyKey?: string;
}

/**
 * The independent sweeper actor (guide 4.6, "an independent sweeper that does
 * not depend on the session").
 *
 * - `register` and `open` are synchronous calls. They answer only after the
 *   rows are durable. The session waits for the answer.
 * - `close` comes through the session's outbox. A lost close causes only a
 *   spurious wake.
 * - The platform cron calls `cron("tick")` often and `cron("sweep")` on a
 *   slower cycle. A tick wakes every session with an open turn past its
 *   horizon. A sweep wakes every registered session once.
 * - The sweeper never needs an outbox delivery to learn that a session has
 *   work. It reads only its own `open_turns` rows.
 */
export class SweeperActor implements ActorBehavior {
  readonly #host: Host;
  readonly #clock: Clock;
  readonly #cfg: RuntimeConfig;

  constructor(host: Host, deps: { clock: Clock; config?: Partial<RuntimeConfig> }) {
    this.#host = host;
    this.#clock = deps.clock;
    this.#cfg = resolveConfig(deps.config);
  }

  async activate(): Promise<void> {
    await this.#host.tx((sql) => {
      for (const q of DDL) sql.exec(q);
    });
    await this.#host.commit();
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const p = params as SweeperCall;
    const now = this.#clock.now();
    switch (method) {
      case "register":
        await this.#host.tx((sql) => {
          fenceEpoch(sql, p.session, p.epoch);
          sql.exec("INSERT OR IGNORE INTO sessions (session, registered_at) VALUES (?, ?)", p.session, now);
        });
        break;
      case "open": // also extends the horizon of an open turn
        await this.#host.tx((sql) => {
          fenceEpoch(sql, p.session, p.epoch);
          if (sql.exec("SELECT 1 AS x FROM sessions WHERE session = ?", p.session).length === 0) {
            throw new Error(`session ${p.session} is not registered`);
          }
          sql.exec(
            "INSERT INTO open_turns (session, turn, horizon) VALUES (?, ?, ?) ON CONFLICT (session, turn) DO UPDATE SET horizon = excluded.horizon",
            p.session,
            p.turn!,
            p.horizon!,
          );
        });
        break;
      case "close":
        await this.#host.tx((sql) => {
          fenceEpoch(sql, p.session, p.epoch);
          const key = p.idempotencyKey;
          if (key !== undefined) {
            if (sql.exec("SELECT 1 AS x FROM applied WHERE id = ?", key).length > 0) return;
            sql.exec("INSERT INTO applied (id) VALUES (?)", key);
          }
          sql.exec("DELETE FROM open_turns WHERE session = ? AND turn = ?", p.session, p.turn!);
        });
        break;
      default:
        throw new Error(`sweeper: unknown method ${method}`);
    }
    await this.#host.commit(); // the answer leaves only when the rows are durable
    return { ok: true };
  }

  async cron(name: string): Promise<void> {
    const now = this.#clock.now();
    const rows = await this.#host.tx((sql) =>
      name === "tick"
        ? sql.exec("SELECT DISTINCT session FROM open_turns WHERE horizon <= ?", now)
        : sql.exec("SELECT session FROM sessions"),
    );
    const sessions = rows.map((r) => str(r.session));
    await Promise.allSettled(sessions.map((s) => this.#wake(s)));
  }

  async #wake(session: string): Promise<void> {
    const turns = await this.#host.tx((sql) =>
      sql.exec("SELECT turn FROM open_turns WHERE session = ? ORDER BY turn", session),
    );
    const openTurns = turns.map((t) => str(t.turn));
    await this.#host.sidecar(this.#cfg.actorTarget(session)).call("wake", { openTurns });
  }
}
