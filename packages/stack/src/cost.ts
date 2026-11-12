import type { BenchResult } from "./bench.ts";

/**
 * Cost per user-month from a bench result, at list prices. Marginal cost: the free
 * allowances of a plan are left out, because they are shared by every user of an account.
 *
 * Sources, read 2026-11-12:
 * - Cloudflare Durable Objects (developers.cloudflare.com/durable-objects/platform/pricing,
 *   updated 2026-10-18): $0.15 per million requests (alarms count), $12.50 per million
 *   GB-s at 128 MB per object, billed while running or held in memory by pending I/O;
 *   SQLite rows written $1.00 per million (each setAlarm is one row), rows read $0.001 per
 *   million, storage $0.20 per GB-month.
 * - The always-on VM: Hetzner CPX02 (1 vCPU, 1 GB) EUR 6.49 = $8.09 per month, the cheapest
 *   orderable shared plan (agentdeals.dev/hetzner-pricing-2026, prices from Hetzner's API
 *   on 2026-10-31; a secondary source). The baseline run says whether 1 GB is enough.
 */
export const PRICES = {
  doRequestUsd: 0.15 / 1e6,
  doGbSecondUsd: 12.5 / 1e6,
  doMemoryGb: 0.128,
  doRowWrittenUsd: 1.0 / 1e6,
  doStorageGbMonthUsd: 0.2,
  vmMonthUsd: 8.09,
} as const;

export interface UsageAssumption {
  /** Turns per user per month. */
  turnsPerMonth: number;
  /** Stored session data per user, GB. */
  storageGb: number;
}

/** About 30 turns a day, and 50 MB of history. Change these to your users. */
export const DEFAULT_USAGE: UsageAssumption = { turnsPerMonth: 900, storageGb: 0.05 };

export interface CostLine {
  requests: number;
  duration: number;
  rowsWritten: number;
  storage: number;
  total: number;
}

export function durableObjectsCost(r: BenchResult, u: UsageAssumption = DEFAULT_USAGE): CostLine {
  const t = u.turnsPerMonth;
  const requests = r.perTurn.events * t * PRICES.doRequestUsd;
  const duration = (r.perTurn.busyMs / 1000) * PRICES.doMemoryGb * t * PRICES.doGbSecondUsd;
  // A row the SQL changed, plus the alarm rows (each arm sets the alarm once).
  const rows = Math.max(0, r.perTurn.rowsChanged) + r.perTurn.arms;
  const rowsWritten = rows * t * PRICES.doRowWrittenUsd;
  const storage = u.storageGb * PRICES.doStorageGbMonthUsd;
  const total = requests + duration + rowsWritten + storage;
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { requests: r6(requests), duration: r6(duration), rowsWritten: r6(rowsWritten), storage: r6(storage), total: r6(total) };
}
