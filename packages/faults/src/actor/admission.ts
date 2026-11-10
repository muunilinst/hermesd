/**
 * Reads a row of `session_admissions`, which has upstream's columns, as one
 * word for tests: `queued`, `started`, `unknown`, or `terminal:<outcome>`.
 */
export function admissionState(row: Record<string, unknown>): string {
  return row.status === "terminal" ? `terminal:${String(row.outcome)}` : String(row.status);
}
