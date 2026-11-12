import type { Host, Sql, SqlRow } from "@hermesd/host";
import { enqueueOutbox, Outbox, OUTBOX_DDL, outboxWriter } from "./outbox.ts";
import {
  resolveConfig,
  type ActorBehavior,
  type AppendResult,
  type PendingRow,
  type ReceiveParams,
  type ReceiveResult,
  type RuntimeConfig,
  type SessionDeps,
  type StepSpec,
  type TurnContext,
} from "./types.ts";
import { num, sha256Hex, str } from "./util.ts";

/** The tables of one session actor. */
export const SESSION_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS rt_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // The inbox. A message is a row first and an event second (guide 4.6, "inbox is authoritative").
  // This is upstream's table (`hermes_state_common.py:591`): same name, columns, statuses and
  // unique keys (contracts/upstream/ledger.json). Two differences, both on purpose:
  // - `target_session_id` has no FOREIGN KEY. Upstream refers to `sessions(id)`. This package does
  //   not own `sessions`, and an admission is written before the session row exists.
  // - The port's own needs are in the side table `rt_admission_port`, not in extra columns.
  `CREATE TABLE IF NOT EXISTS session_admissions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    admission_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    lineage_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    intent TEXT NOT NULL CHECK (intent IN ('queue','steer','redirect')),
    status TEXT NOT NULL CHECK (status IN ('queued','started','unknown','terminal')),
    outcome TEXT,
    owner_epoch INTEGER,
    generation INTEGER,
    UNIQUE (principal_id, target_session_id, request_id),
    CHECK (status != 'started' OR (owner_epoch IS NOT NULL AND generation IS NOT NULL))
  )`,
  // What upstream's admission row has no place for: the turn that runs it, the result text, the
  // epoch of the actor that took it in, and times. One row for each admission, same seq.
  `CREATE TABLE IF NOT EXISTS rt_admission_port (
    seq INTEGER PRIMARY KEY,
    turn_id TEXT,
    result TEXT,
    received_epoch INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    admission_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'done', 'failed', 'unknown')),
    horizon INTEGER NOT NULL,
    steps INTEGER NOT NULL DEFAULT 0,
    wakes INTEGER NOT NULL DEFAULT 0, -- driver failures since the last recorded step
    error TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS pending_rows (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
    attempts INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wake_obligations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    turn_id TEXT,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'done')),
    epoch INTEGER NOT NULL
  )`,
  OUTBOX_DDL,
  // The simple transcript of the test driver. A real session actor keeps the
  // upstream `messages` table instead, so the two never share a name.
  `CREATE TABLE IF NOT EXISTS rt_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id TEXT,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS job_runs (
    obligation_id TEXT PRIMARY KEY,
    job TEXT NOT NULL,
    ran_at INTEGER NOT NULL
  )`,
  // Every key this actor may have a host timer for. A key is written (and committed) before its
  // arm, and leaves only once the host has disarmed it. A key whose obligation is not open is a
  // timer to remove, also one that an arm in flight or a crash left behind. Each arm raises `gen`,
  // so a cleanup can tell that the key was claimed again after it decided to remove it.
  `CREATE TABLE IF NOT EXISTS rt_timers (key TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0)`,
];

interface Armed {
  at: number;
  key: string;
}

/**
 * A session actor. It holds the rules of guide sections 4.6, 6.3 and 6.4 that
 * do not depend on a platform:
 *
 * - wake obligations: "arm first, then commit", "re-arm first in the handler",
 *   a minimum delay, and a re-arm when a handler finds an open turn and no
 *   due obligation;
 * - the inbox (`session_admissions`) and the transactional outbox;
 * - the registration and the horizon of the independent sweeper.
 *
 * It imports the `Host` interface only. The application part of a turn comes
 * in as a `TurnDriver`.
 */
export class SessionActor implements ActorBehavior {
  readonly #host: Host;
  readonly #deps: SessionDeps;
  readonly #cfg: RuntimeConfig;
  readonly #outbox: Outbox;
  /** Turns that a driver is running in this activation. Lost on a crash. */
  readonly #active = new Set<string>();
  /** Turns that got a poke while their driver ran. They run once more when it ends. */
  readonly #repoke = new Set<string>();
  #seq = 0;
  #draining = false;
  #again = false;
  #registered = false;
  /** Keys with an arm in flight, or armed for an obligation not committed yet: not stale. */
  readonly #arming = new Map<string, number>();
  #reconciling = false;
  /** Counts cleanup requests: a hold that saw one may have kept a stale key, and cleans up when it ends. */
  #cleanups = 0;
  #reconcileAgain = false;

  constructor(host: Host, deps: SessionDeps) {
    this.#host = host;
    this.#deps = deps;
    this.#cfg = resolveConfig(deps.config);
    this.#outbox = new Outbox(host, deps.clock);
  }

  // ------------------------------------------------------------ platform entry points

  async activate(): Promise<void> {
    await this.#host.tx((sql) => {
      for (const q of SESSION_DDL) sql.exec(q);
    });
    await this.#host.commit();
    // Reconcile on activation: register, send old outbox rows, start the next admission.
    this.#background(async () => {
      await this.#reconcileTimers(); // a crash may have come between a close and its disarm
      await this.#ensureRegistered();
      await this.#deliver();
      this.#kick();
    });
  }

  /** The alarm fired. The alarm carries no data: the handler scans its own rows. */
  async alarm(): Promise<void> {
    await this.#wake();
  }

  async call(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "receive":
        return this.receive(params as ReceiveParams);
      case "wake": {
        // From the sweeper. It lists the turns that it believes are open.
        await this.#wake();
        const theirs = ((params as { openTurns?: string[] } | undefined)?.openTurns ?? []) as string[];
        if (theirs.length > 0) await this.#closeUnknownTurns(theirs);
        return { ok: true };
      }
      case "append":
        return this.#append(params as { role: string; text: string; expectedTail?: number; turnId?: string });
      case "schedule_job": {
        const p = params as { job: string; dueAt?: number };
        await this.#commitWithObligation({ kind: "cron", ref: p.job, turnId: null, ...(p.dueAt !== undefined ? { dueAt: p.dueAt } : {}) }, (_sql, add) => {
          add();
        });
        return { ok: true };
      }
      case "flush_outbox": {
        const p = (params ?? {}) as { olderThanMs?: number };
        const sent = await this.#outbox.deliver(p.olderThanMs !== undefined ? { olderThanMs: p.olderThanMs } : {});
        return { ok: true, sent };
      }
      case "tail":
        return { tail: await this.#tail() };
      case "poke": {
        // An event for an open turn (a tool result, an answer, an interrupt). Drive it now.
        const p = (params ?? {}) as { count?: boolean };
        await this.#poke(p.count === true);
        return { ok: true };
      }
      case "kick":
        this.#kick();
        return { ok: true };
      default:
        throw new Error(`session: unknown method ${method}`);
    }
  }

  // ------------------------------------------------------------ inbox

  /**
   * An inbound message. Write one `session_admissions` row, commit, answer.
   * This never runs the turn. A second message with the same
   * (principal, session, request) finds the first row and writes nothing.
   */
  async receive(p: ReceiveParams): Promise<ReceiveResult> {
    if (p.session !== this.#host.id()) throw new Error(`message is for session ${p.session}, not ${this.#host.id()}`);
    // The session registers with the sweeper before its first admission.
    await this.#ensureRegistered();
    const now = this.#deps.clock.now();
    const epoch = this.#host.epoch();
    const payload = JSON.stringify({ input: p.input });
    const digest = await sha256Hex(payload);
    const admissionId = [p.principal, p.session, p.request].map(encodeURIComponent).join(":");
    const res = await this.#host.tx((sql): ReceiveResult => {
      const ex = sql.exec(
        "SELECT seq, status FROM session_admissions WHERE principal_id = ? AND target_session_id = ? AND request_id = ?",
        p.principal,
        p.session,
        p.request,
      )[0];
      if (ex) return { admissionId: num(ex.seq), status: str(ex.status), duplicate: true };
      const ins = sql.exec(
        `INSERT INTO session_admissions
           (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status)
         VALUES (?, ?, ?, ?, '{}', ?, ?, 'queue', 'queued') RETURNING seq`,
        admissionId,
        p.request,
        p.principal,
        p.session,
        payload,
        digest,
      );
      const seq = num(ins[0]!.seq);
      sql.exec("INSERT INTO rt_admission_port (seq, received_epoch, created_at, updated_at) VALUES (?, ?, ?, ?)", seq, epoch, now, now);
      return { admissionId: seq, status: "queued", duplicate: false };
    });
    await this.#host.commit();
    this.#kick();
    return res;
  }

  // ------------------------------------------------------------ the transcript

  async #tail(): Promise<number> {
    return this.#host.tx((sql) => num(sql.exec("SELECT COALESCE(MAX(seq), 0) AS t FROM rt_messages")[0]!.t));
  }

  /**
   * Append a message in one transaction. With `expectedTail` this is a
   * compare-and-set: the read and the write are one transaction, so two
   * parallel actions cannot both append (Rivet actions interleave at every await).
   */
  async #append(p: { role: string; text: string; expectedTail?: number; turnId?: string }): Promise<AppendResult> {
    const now = this.#deps.clock.now();
    const profile = this.#cfg.profileTarget;
    const res = await this.#host.tx((sql): AppendResult => {
      const tail = num(sql.exec("SELECT COALESCE(MAX(seq), 0) AS t FROM rt_messages")[0]!.t);
      if (p.expectedTail !== undefined && p.expectedTail !== tail) return { ok: false, tail };
      const ins = sql.exec(
        "INSERT INTO rt_messages (turn_id, role, text, created_at) VALUES (?, ?, ?, ?) RETURNING seq",
        p.turnId ?? null,
        p.role,
        p.text,
        now,
      );
      const seq = num(ins[0]!.seq);
      // Searchable text changed: the profile index must hear about it (guide 6.4).
      if (profile) enqueueOutbox(sql, now, profile, "index", { seq, role: p.role, text: p.text });
      return { ok: true, seq, tail: seq };
    });
    await this.#host.commit();
    if (res.ok) this.#deliverInBackground();
    return res;
  }

  // ------------------------------------------------------------ wake obligations

  #newObligationId(): string {
    return `${this.#host.id()}:${this.#host.epoch()}:${++this.#seq}`;
  }

  /**
   * Arm first, then commit (guide 4.6).
   *
   * 1. Pick a due time that is at least the minimum delay away.
   * 2. Arm the timer. The alarm goes to the earliest open obligation, because a
   *    platform may have one alarm only.
   * 3. If the arm fails, throw. Nothing is committed.
   * 4. Commit the rows that `write` makes, and the obligation row that `add` makes.
   */
  async #commitWithObligation<T>(
    spec: { kind: string; ref: string; turnId: string | null; dueAt?: number },
    write: (sql: Sql, add: () => string) => T,
  ): Promise<T> {
    const now = this.#deps.clock.now();
    const due = Math.max(spec.dueAt ?? 0, now + this.#cfg.minDelayMs);
    const id = this.#newObligationId();
    const earliest = await this.#host.tx((sql): Armed | null => {
      const r = sql.exec("SELECT id, due_at FROM wake_obligations WHERE state = 'open' ORDER BY due_at LIMIT 1")[0];
      return r ? { at: num(r.due_at), key: str(r.id) } : null;
    });
    // An earlier timer covers this obligation too: arm that key again rather than add one. The key
    // is held until the commit, so no cleanup removes it meanwhile, and the arm puts it back if one
    // already did. After the hold its cleanup arms the earliest open obligation before it disarms.
    const armAt: Armed = earliest && earliest.at <= due ? earliest : { at: due, key: id };
    return this.#holding(armAt.key, async () => {
      await this.#arm(armAt.at, armAt.key);
      const epoch = this.#host.epoch();
      const value = await this.#host.tx((sql) =>
        write(sql, () => {
          sql.exec(
            "INSERT INTO wake_obligations (id, kind, ref, turn_id, due_at, state, epoch) VALUES (?, ?, ?, ?, ?, 'open', ?)",
            id,
            spec.kind,
            spec.ref,
            spec.turnId,
            due,
            epoch,
          );
          return id;
        }),
      );
      await this.#host.commit();
      return value;
    });
  }

  /** Record the key, then arm it. The caller holds the key (see `#holding`). */
  async #arm(at: number, key: string): Promise<void> {
    if (this.#host.disarm) {
      await this.#host.tx((sql) => sql.exec("INSERT INTO rt_timers (key, gen) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET gen = gen + 1", key));
      await this.#host.commit();
    }
    await this.#host.arm(new Date(at), key);
  }

  /** Keep `key` out of the cleanup while `fn` runs; then clean up, in case it went stale meanwhile. */
  async #holding<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.#arming.set(key, (this.#arming.get(key) ?? 0) + 1);
    const cleanups = this.#cleanups;
    try {
      return await fn();
    } finally {
      const n = this.#arming.get(key)! - 1;
      if (n === 0) this.#arming.delete(key);
      else this.#arming.set(key, n);
      if (this.#cleanups !== cleanups) this.#background(() => this.#reconcileTimers());
    }
  }

  /** Arm the earliest open obligation with its own key. */
  async #armEarliest(): Promise<void> {
    const next = await this.#host.tx((sql) => sql.exec("SELECT id, due_at FROM wake_obligations WHERE state = 'open' ORDER BY due_at, id LIMIT 1")[0]);
    if (next) await this.#holding(str(next.id), () => this.#arm(num(next.due_at), str(next.id)));
  }

  /**
   * Remove the host timers of closed obligations (listed in `rt_disarm`), so a finished session stops
   * waking. An open obligation may have borrowed one of those timers, so the earliest open one is
   * armed first, and unsent outbox rows get their own obligation first. It runs after each commit
   * that may close obligations, and on activation. It never throws: the work is in rows, so a
   * failure is redone by the next run.
   */
  async #reconcileTimers(): Promise<void> {
    if (!this.#host.disarm) return;
    this.#cleanups++;
    if (this.#reconciling) {
      this.#reconcileAgain = true; // a key may have gone stale after the running pass read the rows
      return;
    }
    this.#reconciling = true;
    try {
      do {
        this.#reconcileAgain = false;
        await this.#reconcilePass();
      } while (this.#reconcileAgain);
    } catch {
      // The keys stay in rt_timers for the next run.
    } finally {
      this.#reconciling = false;
    }
  }

  async #reconcilePass(): Promise<void> {
    await this.#ensureOutboxWake();
    const stale = await this.#host.tx((sql) =>
      sql
        .exec("SELECT key, gen FROM rt_timers WHERE key NOT IN (SELECT id FROM wake_obligations WHERE state = 'open') ORDER BY key")
        .map((r) => ({ key: str(r.key), gen: num(r.gen) })),
    );
    const keys = stale.filter((k) => !this.#arming.has(k.key));
    if (keys.length === 0) return;
    await this.#armEarliest();
    for (const k of keys) await this.#host.disarm!(k.key);
    // An arm may have claimed a key after it was read here (a new obligation reuses an earlier
    // timer), and the disarm above may have removed that arm's timer. Such a key has a new `gen`:
    // its row stays, and the next pass arms the earliest open obligation again before it looks.
    const claimed = await this.#host.tx((sql) => {
      let n = 0;
      for (const k of keys) if (sql.exec("DELETE FROM rt_timers WHERE key = ? AND gen = ? RETURNING key", k.key, k.gen).length === 0) n++;
      return n;
    });
    await this.#host.commit();
    if (claimed > 0) this.#reconcileAgain = true;
  }


  /** Unsent outbox rows keep an "outbox" obligation of their own, due a retry from now. */
  async #ensureOutboxWake(): Promise<void> {
    const need = await this.#host.tx(
      (sql) =>
        sql.exec("SELECT 1 AS x FROM outbox LIMIT 1").length > 0 &&
        sql.exec("SELECT 1 AS x FROM wake_obligations WHERE kind = 'outbox' AND state = 'open' LIMIT 1").length === 0,
    );
    if (need) await this.#commitWithObligation({ kind: "outbox", ref: "", turnId: null }, (_sql, add) => add());
  }

  /** Send the outbox. Once it is empty, close the "outbox" obligations; until then they keep a retry. */
  async #deliver(): Promise<void> {
    await this.#outbox.deliver();
    await this.#host.tx((sql) => {
      if (sql.exec("SELECT 1 AS x FROM outbox LIMIT 1").length === 0) {
        sql.exec("UPDATE wake_obligations SET state = 'done' WHERE kind = 'outbox' AND state = 'open'");
      }
    });
    await this.#host.commit();
    await this.#reconcileTimers();
  }

  /**
   * The wake handler (guide 4.6).
   *
   * 1. Its first durable action is the re-arm: the next obligation, or a retry
   *    of the due ones one minimum delay later. If no obligation exists but a
   *    turn is open, it adds one. It never ends with an open turn and no timer.
   * 2. Only then it does the work: horizon extension, cron jobs, open turns.
   * 3. A handler that finds no due obligation does no work. A timer that fired
   *    early is not lost: the re-arm kept the next obligation armed.
   */
  async #wake(): Promise<void> {
    const now = this.#deps.clock.now();
    const retryAt = now + this.#cfg.minDelayMs;
    const snap = await this.#host.tx((sql) => ({
      due: sql.exec(
        "SELECT id, kind, ref, turn_id FROM wake_obligations WHERE state = 'open' AND due_at <= ? ORDER BY due_at, id",
        now,
      ),
      next: sql.exec("SELECT id, due_at FROM wake_obligations WHERE state = 'open' AND due_at > ? ORDER BY due_at LIMIT 1", now)[0],
      openTurn: sql.exec("SELECT id FROM turns WHERE status = 'open' ORDER BY id LIMIT 1")[0],
    }));

    const next: Armed | null = snap.next ? { at: num(snap.next.due_at), key: str(snap.next.id) } : null;
    let rearm: (Armed & { recheckFor?: string }) | null = null;
    if (snap.due.length > 0) {
      rearm = next && next.at < retryAt ? next : { at: retryAt, key: str(snap.due[0]!.id) };
    } else if (next) {
      rearm = next;
    } else if (snap.openTurn) {
      rearm = { at: retryAt, key: this.#newObligationId(), recheckFor: str(snap.openTurn.id) };
    }
    if (rearm) {
      const target = rearm;
      await this.#holding(target.key, async () => {
        await this.#arm(target.at, target.key);
        const epoch = this.#host.epoch();
        await this.#host.tx((sql) => {
          for (const o of snap.due) {
            sql.exec("UPDATE wake_obligations SET due_at = ? WHERE id = ? AND state = 'open' AND due_at <= ?", retryAt, str(o.id), now);
          }
          if (target.recheckFor) {
            sql.exec(
              "INSERT INTO wake_obligations (id, kind, ref, turn_id, due_at, state, epoch) VALUES (?, 'recheck', ?, ?, ?, 'open', ?)",
              target.key,
              target.recheckFor,
              target.recheckFor,
              target.at,
              epoch,
            );
          }
        });
        await this.#host.commit();
      });
    }

    await this.#extendHorizons();
    const turns = new Set<string>();
    for (const o of snap.due) {
      if (str(o.kind) === "cron") await this.#runJob(str(o.id), str(o.ref));
      else if (str(o.kind) === "outbox") await this.#deliver();
      else if (o.turn_id !== null && o.turn_id !== undefined) turns.add(str(o.turn_id));
    }
    for (const t of turns) await this.#resumeTurn(t);
    await this.#reconcileTimers();
    this.#kick();
    this.#deliverInBackground();
  }

  /** Run a cron job once. The effect and the closing of the obligation are one transaction. */
  async #runJob(obligationId: string, job: string): Promise<void> {
    const fn = this.#deps.jobs?.[job];
    if (!fn) return; // no code for it in this build: keep the obligation open
    const now = this.#deps.clock.now();
    await this.#host.tx((sql) => {
      const claimed = sql.exec("UPDATE wake_obligations SET state = 'done' WHERE id = ? AND state = 'open' RETURNING id", obligationId);
      if (claimed.length === 0) return; // a second firing finds it done: a no-op
      fn(sql, outboxWriter(sql, now), { obligationId });
      sql.exec("INSERT INTO job_runs (obligation_id, job, ran_at) VALUES (?, ?, ?)", obligationId, job, now);
    });
    await this.#host.commit();
    await this.#reconcileTimers();
  }

  // ------------------------------------------------------------ the sweeper

  async #ensureRegistered(): Promise<void> {
    if (this.#registered) return;
    const done = await this.#host.tx((sql) => sql.exec("SELECT 1 AS x FROM rt_meta WHERE key = 'registered'").length > 0);
    if (!done) {
      await this.#host
        .sidecar(this.#cfg.sweeperTarget)
        .call("register", { session: this.#host.id(), epoch: this.#host.epoch() });
      await this.#host.tx((sql) => sql.exec("INSERT OR REPLACE INTO rt_meta (key, value) VALUES ('registered', '1')"));
      await this.#host.commit();
    }
    this.#registered = true;
  }

  async #sweeperOpen(turnId: string, horizon: number): Promise<void> {
    await this.#host
      .sidecar(this.#cfg.sweeperTarget)
      .call("open", { session: this.#host.id(), epoch: this.#host.epoch(), turn: turnId, horizon });
  }

  /** A turn that runs past half of its horizon extends it, the same way as at its start. */
  async #extendHorizons(): Promise<void> {
    const now = this.#deps.clock.now();
    const rows = await this.#host.tx((sql) => sql.exec("SELECT id, horizon FROM turns WHERE status = 'open'"));
    for (const r of rows) {
      if (num(r.horizon) - now > this.#cfg.horizonMs / 2) continue;
      await this.#extend(str(r.id));
    }
  }

  async #extend(turnId: string): Promise<void> {
    const horizon = this.#deps.clock.now() + this.#cfg.horizonMs;
    await this.#sweeperOpen(turnId, horizon);
    await this.#host.tx((sql) => sql.exec("UPDATE turns SET horizon = ? WHERE id = ? AND status = 'open' AND horizon < ?", horizon, turnId, horizon));
    await this.#host.commit();
  }

  /** The sweeper lists open turns that this session does not have open. Tell it to close them. */
  async #closeUnknownTurns(theirs: string[]): Promise<void> {
    const now = this.#deps.clock.now();
    const target = this.#cfg.sweeperTarget;
    await this.#host.tx((sql) => {
      for (const t of theirs) {
        if (sql.exec("SELECT 1 AS x FROM turns WHERE id = ? AND status = 'open'", t).length > 0) continue;
        // An admission that is still queued may open this turn soon: leave the record.
        const waiting = sql.exec("SELECT 1 AS x FROM session_admissions WHERE 'turn-' || seq = ? AND status IN ('queued', 'started')", t);
        const queued = sql.exec("SELECT 1 AS x FROM outbox WHERE method = 'close' AND target = ? AND payload = ?", target, JSON.stringify({ turn: t }));
        if (waiting.length === 0 && queued.length === 0) enqueueOutbox(sql, now, target, "close", { turn: t });
      }
    });
    await this.#host.commit();
    this.#deliverInBackground();
  }

  // ------------------------------------------------------------ turns

  /** Start the next queued admission, if no admission is started or unknown. One at a time. */
  #kick(): void {
    if (this.#draining) {
      this.#again = true;
      return;
    }
    this.#draining = true;
    this.#background(async () => {
      try {
        do {
          this.#again = false;
          while (await this.#startNext()) {
            /* go on */
          }
        } while (this.#again);
      } finally {
        this.#draining = false;
      }
    });
  }

  async #startNext(): Promise<boolean> {
    const cand = await this.#host.tx((sql) => {
      // Later inputs wait while one is started or unknown (guide 6.3).
      if (sql.exec("SELECT 1 AS x FROM session_admissions WHERE status IN ('started', 'unknown') LIMIT 1").length > 0) return undefined;
      return sql.exec("SELECT seq AS id, json_extract(payload_json, '$.input') AS input FROM session_admissions WHERE status = 'queued' ORDER BY seq LIMIT 1")[0];
    });
    if (!cand) return false;
    await this.#ensureRegistered();
    const admissionId = num(cand.id);
    const turnId = `turn-${admissionId}`;
    const now = this.#deps.clock.now();
    const horizon = now + this.#cfg.horizonMs;
    // Synchronous open. If it fails the turn does not start, and the admission stays queued.
    await this.#sweeperOpen(turnId, horizon);
    const started = await this.#commitWithObligation({ kind: "turn", ref: turnId, turnId }, (sql, add) => {
      // Upstream: a started row has the owner epoch and a generation (CHECK in the table).
      const ok = sql.exec(
        `UPDATE session_admissions
           SET status = 'started', owner_epoch = ?, generation = (SELECT COALESCE(MAX(generation), 0) + 1 FROM session_admissions)
         WHERE seq = ? AND status = 'queued'
           AND NOT EXISTS (SELECT 1 FROM session_admissions WHERE status IN ('started', 'unknown'))
         RETURNING seq`,
        this.#host.epoch(),
        admissionId,
      );
      if (ok.length === 0) return false;
      sql.exec("UPDATE rt_admission_port SET turn_id = ?, updated_at = ? WHERE seq = ?", turnId, now, admissionId);
      sql.exec("INSERT INTO turns (id, admission_id, status, horizon, started_at) VALUES (?, ?, 'open', ?, ?)", turnId, admissionId, horizon, now);
      add();
      return true;
    });
    if (!started) return false;
    await this.#drive(turnId, async (ctx) => this.#deps.driver.start(ctx));
    return true;
  }

  async #drive(turnId: string, run: (ctx: TurnContext) => Promise<void>): Promise<void> {
    if (this.#active.has(turnId)) return;
    this.#active.add(turnId);
    try {
      const row = await this.#host.tx((sql) =>
        sql.exec("SELECT t.admission_id AS aid, json_extract(a.payload_json, '$.input') AS input FROM turns t JOIN session_admissions a ON a.seq = t.admission_id WHERE t.id = ?", turnId)[0],
      );
      if (!row) return;
      await run(this.#makeContext(turnId, num(row.aid), str(row.input)));
    } catch {
      // The driver failed. The turn stays open, its obligation stays open, and a wake drives it again.
      // The failure is counted. Too many failures without a recorded step end the turn with a visible error.
      await this.#host.tx((sql) => sql.exec("UPDATE turns SET wakes = wakes + 1 WHERE id = ?", turnId)).catch(() => {});
    } finally {
      this.#active.delete(turnId);
      if (this.#repoke.delete(turnId)) {
        this.#background(() => this.#resumeTurn(turnId, { count: false, poke: true }));
      }
    }
  }

  /**
   * Drive every open turn now, without waiting for an obligation. An event
   * (a tool result, a user answer, an interrupt) uses this. By default it does
   * not count as a retry of a pending row.
   */
  async #poke(count: boolean): Promise<void> {
    const rows = await this.#host.tx((sql) => sql.exec("SELECT id FROM turns WHERE status = 'open' ORDER BY id"));
    for (const r of rows) await this.#resumeTurn(str(r.id), { count, poke: true });
  }

  /** A wake found due obligations of this turn. */
  async #resumeTurn(turnId: string, opts: { count: boolean; poke?: boolean } = { count: true }): Promise<void> {
    if (this.#active.has(turnId)) {
      // A driver is running here; the handler's re-arm covers the next wake.
      // A poke is an event the running driver may have missed: run once more when it ends.
      if (opts.poke) this.#repoke.add(turnId);
      return;
    }
    const info = await this.#host.tx((sql) => {
      const t = sql.exec("SELECT status, steps, wakes FROM turns WHERE id = ?", turnId)[0];
      if (!t || str(t.status) !== "open") {
        // A stale obligation of a turn that ended: close it.
        sql.exec("UPDATE wake_obligations SET state = 'done' WHERE turn_id = ? AND state = 'open'", turnId);
        return null;
      }
      if (opts.count) sql.exec("UPDATE pending_rows SET attempts = attempts + 1 WHERE turn_id = ? AND status = 'pending'", turnId);
      const pend = sql.exec("SELECT id, turn_id, kind, payload, attempts FROM pending_rows WHERE turn_id = ? AND status = 'pending' ORDER BY created_at, id", turnId);
      return { steps: num(t.steps), failures: num(t.wakes), pend };
    });
    await this.#host.commit(); // the retry is counted before the driver acts
    if (!info) return this.#reconcileTimers();
    if (info.failures >= this.#cfg.maxFailuresWithoutProgress) {
      await this.#closeTurn(turnId, "failed", `the turn failed ${info.failures} times without progress`);
      return;
    }
    if (info.pend.length > 0) {
      const rows = info.pend.map(toPending);
      await this.#drive(turnId, (ctx) => this.#deps.driver.resume(ctx, rows));
    } else if (info.steps === 0) {
      // Nothing was recorded, so nothing was sent. Starting again is safe.
      await this.#drive(turnId, (ctx) => this.#deps.driver.start(ctx));
    } else {
      // A step was done and the next one was not recorded: exactly as upstream, ask the user.
      await this.#closeTurn(turnId, "unknown", "the owner was lost between steps; the next step was not recorded");
    }
  }

  /** The rows of "end a turn". It runs inside a transaction. Returns false if the turn was not open. */
  #closeTurnRows(sql: Sql, turnId: string, outcome: "done" | "failed" | "unknown", text: string, now: number): boolean {
    const r = sql.exec(
      "UPDATE turns SET status = ?, ended_at = ?, error = ? WHERE id = ? AND status = 'open' RETURNING admission_id",
      outcome,
      now,
      outcome === "done" ? null : text,
      turnId,
    );
    if (r.length === 0) return false;
    // done -> terminal/completed, failed -> terminal/failed, unknown -> unknown (upstream's words).
    const seq = num(r[0]!.admission_id);
    if (outcome === "unknown") sql.exec("UPDATE session_admissions SET status = 'unknown' WHERE seq = ?", seq);
    else sql.exec("UPDATE session_admissions SET status = 'terminal', outcome = ? WHERE seq = ?", outcome === "done" ? "completed" : "failed", seq);
    sql.exec("UPDATE rt_admission_port SET result = ?, updated_at = ? WHERE seq = ?", text, now, seq);
    sql.exec("UPDATE pending_rows SET status = 'done' WHERE turn_id = ? AND status = 'pending'", turnId);
    sql.exec("UPDATE wake_obligations SET state = 'done' WHERE turn_id = ? AND state = 'open'", turnId);
    enqueueOutbox(sql, now, this.#cfg.sweeperTarget, "close", { turn: turnId });
    return true;
  }

  #afterClose(outcome: "done" | "failed" | "unknown"): void {
    this.#deliverInBackground();
    if (outcome !== "unknown") this.#kick();
  }

  /** End a turn once. The admission, the pending rows, the obligations and the sweeper record all end with it. */
  async #closeTurn(turnId: string, outcome: "done" | "failed" | "unknown", text: string): Promise<boolean> {
    const now = this.#deps.clock.now();
    const closed = await this.#host.tx((sql) => this.#closeTurnRows(sql, turnId, outcome, text, now));
    await this.#host.commit();
    await this.#reconcileTimers();
    if (closed) this.#afterClose(outcome);
    return closed;
  }

  /** See `TurnContext.step`. */
  async #step(turnId: string, spec: StepSpec): Promise<PendingRow[]> {
    const now = this.#deps.clock.now();
    const pends = spec.pend ?? [];
    if (pends.length > 0 && spec.finish) throw new Error("a step cannot both record pending rows and end the turn");
    const rows: PendingRow[] = pends.map((p) => ({
      id: `${turnId}:${this.#host.epoch()}:p${++this.#seq}`,
      turnId,
      kind: p.kind,
      payload: p.payload,
      attempts: 0,
    }));
    const body = (sql: Sql): boolean => {
      for (const s of spec.settle ?? []) {
        sql.exec("UPDATE pending_rows SET status = 'done', result = ? WHERE id = ? AND status = 'pending'", JSON.stringify(s.result ?? null), s.id);
        sql.exec("UPDATE wake_obligations SET state = 'done' WHERE kind = 'pending' AND ref = ?", s.id);
      }
      spec.write?.(sql, outboxWriter(sql, now));
      for (const r of rows) {
        sql.exec(
          "INSERT INTO pending_rows (id, turn_id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
          r.id,
          turnId,
          r.kind,
          JSON.stringify(r.payload ?? null),
          now,
        );
      }
      if ((spec.settle?.length ?? 0) > 0 || rows.length > 0) sql.exec("UPDATE turns SET steps = steps + 1, wakes = 0 WHERE id = ?", turnId);
      return spec.finish ? this.#closeTurnRows(sql, turnId, spec.finish.status, spec.finish.text, now) : false;
    };
    if (rows.length === 0) {
      const closed = await this.#host.tx(body);
      await this.#host.commit();
      await this.#reconcileTimers();
      if (closed && spec.finish) this.#afterClose(spec.finish.status);
      return rows;
    }
    const horizonRow = await this.#host.tx((sql) => sql.exec("SELECT horizon FROM turns WHERE id = ?", turnId)[0]);
    if (horizonRow && num(horizonRow.horizon) - now <= this.#cfg.horizonMs / 2) await this.#extend(turnId);
    await this.#commitWithObligation({ kind: "pending", ref: rows[0]!.id, turnId }, (sql, add) => {
      body(sql);
      const first = add();
      // One obligation for each pending row. They share the due time, so one arm covers them.
      for (const r of rows.slice(1)) {
        sql.exec(
          "INSERT INTO wake_obligations (id, kind, ref, turn_id, due_at, state, epoch) SELECT ?, 'pending', ?, turn_id, due_at, 'open', epoch FROM wake_obligations WHERE id = ?",
          `${first}:${r.id}`,
          r.id,
          first,
        );
      }
    });
    await this.#reconcileTimers();
    return rows;
  }

  #makeContext(turnId: string, admissionId: number, input: string): TurnContext {
    return {
      turnId,
      admissionId,
      input,
      host: this.#host,
      pend: async (kind, payload) => {
        const now = this.#deps.clock.now();
        const id = `${turnId}:${this.#host.epoch()}:p${++this.#seq}`;
        const horizonRow = await this.#host.tx((sql) => sql.exec("SELECT horizon FROM turns WHERE id = ?", turnId)[0]);
        if (horizonRow && num(horizonRow.horizon) - now <= this.#cfg.horizonMs / 2) await this.#extend(turnId);
        await this.#commitWithObligation({ kind: "pending", ref: id, turnId }, (sql, add) => {
          sql.exec(
            "INSERT INTO pending_rows (id, turn_id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
            id,
            turnId,
            kind,
            JSON.stringify(payload ?? null),
            now,
          );
          sql.exec("UPDATE turns SET steps = steps + 1, wakes = 0 WHERE id = ?", turnId);
          add();
        });
        return { id, turnId, kind, payload, attempts: 0 };
      },
      settle: async (pendingId, result) => {
        await this.#host.tx((sql) => {
          sql.exec("UPDATE pending_rows SET status = 'done', result = ? WHERE id = ? AND status = 'pending'", JSON.stringify(result ?? null), pendingId);
          sql.exec("UPDATE wake_obligations SET state = 'done' WHERE kind = 'pending' AND ref = ?", pendingId);
          sql.exec("UPDATE turns SET steps = steps + 1, wakes = 0 WHERE id = ?", turnId);
        });
        await this.#host.commit();
        await this.#reconcileTimers();
      },
      write: async (fn) => {
        const now = this.#deps.clock.now();
        const out = await this.#host.tx((sql) => fn(sql, outboxWriter(sql, now)));
        await this.#host.commit();
        this.#deliverInBackground();
        return out;
      },
      appendMessage: (role, text, opts) =>
        this.#append({ role, text, turnId, ...(opts?.expectedTail !== undefined ? { expectedTail: opts.expectedTail } : {}) }),
      step: (spec) => this.#step(turnId, spec),
      finish: async (status, text) => {
        await this.#closeTurn(turnId, status, text);
      },
    };
  }

  // ------------------------------------------------------------ background work

  #deliverInBackground(): void {
    this.#background(() => this.#deliver());
  }

  /** Work that no caller waits for. A failure is not lost: rows and obligations bring it back. */
  #background(fn: () => Promise<void>): void {
    const work = fn().catch(() => {});
    if (this.#host.keepAwake) void this.#host.keepAwake(work).catch(() => {});
  }
}

function toPending(r: SqlRow): PendingRow {
  return {
    id: str(r.id),
    turnId: str(r.turn_id),
    kind: str(r.kind),
    payload: JSON.parse(str(r.payload)) as unknown,
    attempts: num(r.attempts),
  };
}
