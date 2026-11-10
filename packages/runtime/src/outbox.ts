import type { Host, Sql } from "@hermesd/host";
import type { Clock, OutboxWriter } from "./types.ts";
import { num, str } from "./util.ts";

/** The session actor's outbox table. */
export const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  method TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
)`;

/** Write one outbox row. Call it inside the transaction of the change that it describes. */
export function enqueueOutbox(sql: Sql, now: number, target: string, method: string, payload: Record<string, unknown>): void {
  sql.exec("INSERT INTO outbox (target, method, payload, created_at) VALUES (?, ?, ?, ?)", target, method, JSON.stringify(payload), now);
}

export function outboxWriter(sql: Sql, now: number): OutboxWriter {
  return { enqueue: (target, method, payload) => enqueueOutbox(sql, now, target, method, payload) };
}

/**
 * Sends outbox rows (guide 4.6, "cross-actor updates use an outbox").
 *
 * Rule per row: send it with the row's ID as the idempotency key, wait for the
 * receiver to confirm, and only then delete it. A crash in between sends the
 * row again. The receiver ignores an ID that it has applied.
 */
export class Outbox {
  readonly #host: Host;
  readonly #clock: Clock;
  #delivering = false;
  #again = false;

  constructor(host: Host, clock: Clock) {
    this.#host = host;
    this.#clock = clock;
  }

  /**
   * Send the rows that are older than `olderThanMs` (all rows by default).
   * One run at a time. Returns the number of rows that the receivers confirmed.
   * A target that fails keeps its rows, in order. Other targets go on.
   */
  async deliver(opts: { olderThanMs?: number } = {}): Promise<number> {
    if (this.#delivering) {
      this.#again = true; // a row may have come after the running pass read the table: run once more
      return 0;
    }
    this.#delivering = true;
    try {
      let sent = 0;
      do {
        this.#again = false;
        sent += await this.#pass(opts.olderThanMs ?? 0);
      } while (this.#again);
      return sent;
    } finally {
      this.#delivering = false;
    }
  }

  async #pass(olderThanMs: number): Promise<number> {
    const cutoff = this.#clock.now() - olderThanMs;
    const rows = await this.#host.tx((sql) =>
      sql.exec("SELECT id, target, method, payload FROM outbox WHERE created_at <= ? ORDER BY id", cutoff),
    );
    const failed = new Set<string>();
    let sent = 0;
    for (const row of rows) {
      const target = str(row.target);
      if (failed.has(target)) continue;
      const id = num(row.id);
      const params = {
        ...(JSON.parse(str(row.payload)) as Record<string, unknown>),
        session: this.#host.id(),
        epoch: this.#host.epoch(),
        idempotencyKey: `${this.#host.id()}#${id}`,
      };
      try {
        const res = (await this.#host.sidecar(target).call(str(row.method), params)) as { ok?: boolean } | undefined;
        if (res && res.ok === false) throw new Error("receiver refused");
      } catch {
        failed.add(target);
        await this.#host.tx((sql) => sql.exec("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?", id));
        continue;
      }
      await this.#host.tx((sql) => sql.exec("DELETE FROM outbox WHERE id = ?", id));
      sent += 1;
    }
    await this.#host.commit();
    return sent;
  }
}
