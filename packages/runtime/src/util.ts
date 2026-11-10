import type { Sql, SqlRow, SqlValue } from "@hermesd/host";

/** The store refused a call that carries a lower owner epoch. */
export class StaleEpochError extends Error {
  readonly code = "stale_epoch";
  constructor(who: string, have: number, seen: number) {
    super(`stale epoch for ${who}: got ${have}, have seen ${seen}`);
    this.name = "StaleEpochError";
  }
}

export function num(v: SqlValue | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new TypeError(`expected a number, got ${String(v)}`);
}

export function str(v: SqlValue | undefined): string {
  if (typeof v === "string") return v;
  throw new TypeError(`expected a string, got ${String(v)}`);
}

export function first(rows: SqlRow[]): SqlRow | undefined {
  return rows[0];
}

/**
 * Receiver-side fence. Remember the highest epoch seen per caller and refuse
 * a lower one. The table is `rt_seen_epochs`. Call this inside a transaction.
 */
export const FENCE_DDL = "CREATE TABLE IF NOT EXISTS rt_seen_epochs (who TEXT PRIMARY KEY, epoch INTEGER NOT NULL)";

export function fenceEpoch(sql: Sql, who: string, epoch: number): void {
  const row = sql.exec("SELECT epoch FROM rt_seen_epochs WHERE who = ?", who)[0];
  const seen = row ? num(row.epoch) : 0;
  if (epoch < seen) throw new StaleEpochError(who, epoch, seen);
  if (epoch > seen) sql.exec("INSERT OR REPLACE INTO rt_seen_epochs (who, epoch) VALUES (?, ?)", who, epoch);
}
