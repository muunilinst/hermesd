import * as fs from "node:fs";
import { dirname } from "node:path";
import type { LaunchStatus } from "@hermesd/executor-protocol";
import { fsyncPath, mkdirpDurable } from "./fsutil.ts";

/**
 * The launch journal: an append-only file of JSON lines on the workspace disk.
 *
 * Every append is written, then the file is synced, then its directory is
 * synced, before the call returns. The helper takes the next step only after
 * that. `seq` rises by one with every record, so the highest `seq` counts the
 * journal writes. The helper reports it at each boot handshake.
 */
export type JournalRecord =
  | {
      seq: number;
      type: "launching";
      opId: string;
      incarnation: number;
      /** 1 for the first launch of the op_id; it rises when a launch is permitted again after not_launched. */
      attempt: number;
      unit: string;
      cmd: string;
      bootId: string;
    }
  | {
      seq: number;
      type: "launched";
      opId: string;
      attempt: number;
      unit: string;
      pid: number;
      startTime: string;
      bootId: string;
    }
  | {
      seq: number;
      type: "outcome";
      opId: string;
      status: LaunchStatus;
      exitCode?: number;
      bootId: string;
    };

/** A record before the journal gives it a sequence number. */
export type NewRecord = JournalRecord extends infer R ? (R extends JournalRecord ? Omit<R, "seq"> : never) : never;

/** The state of one op_id, rebuilt from its records. */
export interface JournalEntry {
  opId: string;
  incarnation: number;
  cmd: string;
  /** The latest launch attempt. */
  attempt: number;
  unit: string;
  /** The boot ID of the latest `launching` record. */
  bootId: string;
  launched: { unit: string; pid: number; startTime: string; bootId: string } | undefined;
  /** The last outcome after the latest `launching` record, if any. */
  outcome: { status: LaunchStatus; exitCode: number | undefined } | undefined;
}

export class JournalCorruptError extends Error {}

/** Final statuses never change. The others can be seen again. */
export function isFinal(status: LaunchStatus | undefined): boolean {
  return status === "done" || status === "failed";
}

export class Journal {
  readonly path: string;
  #records: JournalRecord[] = [];

  constructor(path: string) {
    this.path = path;
    mkdirpDurable(dirname(path));
    this.reload();
  }

  /** The highest sequence number written so far; 0 for an empty journal. */
  get seq(): number {
    return this.#records.at(-1)?.seq ?? 0;
  }

  get records(): readonly JournalRecord[] {
    return this.#records;
  }

  /**
   * Read the file again. A last line that is cut off belongs to a write that
   * never finished and never was synced, so the helper never acted on it; it
   * is dropped. A bad line anywhere else is corruption.
   */
  reload(): void {
    let text = "";
    try {
      text = fs.readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const records: JournalRecord[] = [];
    const lines = text.split("\n");
    const tail = lines.pop() ?? ""; // text after the last newline
    let validBytes = 0;
    for (const line of lines) {
      let rec: JournalRecord;
      try {
        rec = JSON.parse(line) as JournalRecord;
      } catch {
        throw new JournalCorruptError(`bad journal line ${records.length + 1} in ${this.path}`);
      }
      const prev = records.at(-1)?.seq ?? 0;
      if (rec.seq !== prev + 1) throw new JournalCorruptError(`journal sequence gap at line ${records.length + 1}`);
      records.push(rec);
      validBytes += Buffer.byteLength(line) + 1;
    }
    if (tail.length > 0) {
      fs.truncateSync(this.path, validBytes);
      fsyncPath(this.path);
    }
    this.#records = records;
  }

  /** Append one record and make it durable before returning. */
  append(rec: NewRecord): JournalRecord {
    const full = { ...rec, seq: this.seq + 1 } as JournalRecord;
    const fd = fs.openSync(this.path, "a", 0o644);
    try {
      fs.writeSync(fd, JSON.stringify(full) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncPath(dirname(this.path));
    this.#records.push(full);
    return full;
  }

  entry(opId: string): JournalEntry | undefined {
    let e: JournalEntry | undefined;
    for (const r of this.#records) {
      if (r.opId !== opId) continue;
      if (r.type === "launching") {
        e = {
          opId,
          incarnation: r.incarnation,
          cmd: r.cmd,
          attempt: r.attempt,
          unit: r.unit,
          bootId: r.bootId,
          launched: undefined,
          outcome: undefined,
        };
      } else if (e) {
        if (r.type === "launched") {
          e.launched = { unit: r.unit, pid: r.pid, startTime: r.startTime, bootId: r.bootId };
        } else {
          e.outcome = { status: r.status, exitCode: r.exitCode };
        }
      }
    }
    return e;
  }

  /** Every op_id in the journal, in order of first appearance. */
  opIds(): string[] {
    return [...new Set(this.#records.map((r) => r.opId))];
  }
}
