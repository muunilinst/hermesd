/**
 * The request recorder (guide 7.2, golden transcripts; port side).
 *
 * It logs every request that reaches the model, in order. The record is plain
 * JSON. The upstream side can write the same shape later, and
 * `compareGolden` lists the differences. Timestamps, row IDs and call IDs are
 * not part of the comparison.
 */

export const GOLDEN_FORMAT = "hermesd-golden/1";

export interface RecordedRequest {
  /** 0 for the first request. */
  index: number;
  /** The idempotency key. Not compared with upstream. */
  callId: string | null;
  method: string;
  path: string;
  /** The parsed JSON body. */
  body: unknown;
}

export interface GoldenMessage {
  role: string;
  content: string | null;
  tool_calls: unknown;
  tool_call_id: string | null;
  tool_name: string | null;
  finish_reason: string | null;
  active: number;
  compacted: number;
}

export interface GoldenAdmission {
  status: string;
  input: string;
  outcome: string | null;
}

export interface GoldenRecord {
  format: typeof GOLDEN_FORMAT;
  side: "port" | "upstream";
  /** A name for the script of model answers that produced this record. */
  script: string;
  requests: Array<Omit<RecordedRequest, "callId">>;
  rows: { messages: GoldenMessage[]; admissions: GoldenAdmission[] };
}

export class RequestRecorder {
  readonly requests: RecordedRequest[] = [];

  record(req: { callId: string | null; method: string; path: string; body: unknown }): RecordedRequest {
    const r: RecordedRequest = { index: this.requests.length, ...req };
    this.requests.push(r);
    return r;
  }

  /** The record in the shared JSON format. `rows` comes from the database of the run. */
  toGolden(script: string, rows: GoldenRecord["rows"], side: GoldenRecord["side"] = "port"): GoldenRecord {
    return {
      format: GOLDEN_FORMAT,
      side,
      script,
      requests: this.requests.map(({ callId: _callId, ...rest }) => rest),
      rows,
    };
  }
}

type Row = Record<string, unknown>;

/** Messages in the shape of the record. Reads rows of the upstream `messages` table. */
export function goldenMessages(rows: Row[]): GoldenMessage[] {
  return rows.map((r) => ({
    role: String(r.role),
    content: (r.content as string | null) ?? null,
    tool_calls: typeof r.tool_calls === "string" ? (JSON.parse(r.tool_calls) as unknown) : null,
    tool_call_id: (r.tool_call_id as string | null) ?? null,
    tool_name: (r.tool_name as string | null) ?? null,
    finish_reason: (r.finish_reason as string | null) ?? null,
    active: Number(r.active),
    compacted: Number(r.compacted),
  }));
}

/** Admissions in the shape of the record. Reads rows of `session_admissions`, which has upstream's columns. */
export function goldenAdmissions(rows: Row[]): GoldenAdmission[] {
  return rows.map((r) => ({
    status: String(r.status),
    input: String((JSON.parse(String(r.payload_json)) as { input: unknown }).input),
    outcome: (r.outcome as string | null) ?? null,
  }));
}

/** The differences between two records, as readable lines. An empty list means they agree. */
export function compareGolden(a: GoldenRecord, b: GoldenRecord): string[] {
  const diffs: string[] = [];
  const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
  if (a.requests.length !== b.requests.length) diffs.push(`request count: ${a.requests.length} against ${b.requests.length}`);
  for (let i = 0; i < Math.min(a.requests.length, b.requests.length); i++) {
    if (!same(a.requests[i]!.body, b.requests[i]!.body)) diffs.push(`request ${i}: the bodies differ`);
  }
  if (!same(a.rows.messages, b.rows.messages)) diffs.push("messages rows differ");
  if (!same(a.rows.admissions, b.rows.admissions)) diffs.push("session_admissions rows differ");
  return diffs;
}
