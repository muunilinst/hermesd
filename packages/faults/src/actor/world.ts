import {
  resolveConfig,
  SessionActor,
  SweeperActor,
  type JobFn,
  type PendingRow,
  type RuntimeConfig,
  type TurnContext,
  type TurnDriver,
} from "@hermesd/runtime";
import type { ActorBackend } from "./backend.ts";
import { ProfileStub } from "./profile-stub.ts";

/** One model call that the scripted driver sent. */
export interface SentCall {
  turnId: string;
  callId: string;
  /** 1 for the first send, 2 for the first re-send after a wake, and so on. */
  send: number;
}

/**
 * A turn driver for the tests. It plays a one-step turn: write a pending
 * row for a model call (arm first, then commit), send the call, record the
 * reply, add a message, end the turn.
 */
export class ScriptedDriver implements TurnDriver {
  /** Every send, in order. A re-send after a wake reuses the call ID. */
  readonly sent: SentCall[] = [];
  /** Does the model answer? If false, the call never returns and the wake must re-drive it. */
  answers = true;
  /** Give up after this many re-sends and end the turn with a visible error. */
  maxResends = 3;
  /** A test hook that runs after the pending row is committed and before the send. */
  afterPend: ((ctx: TurnContext) => Promise<void>) | undefined;
  /** A test hook that runs at the start of each `resume`. */
  onResume: ((ctx: TurnContext, pending: PendingRow[]) => Promise<void>) | undefined;
  starts = 0;

  async start(ctx: TurnContext): Promise<void> {
    this.starts += 1;
    const callId = `${ctx.turnId}:call-1`;
    const row = await ctx.pend("model_call", { callId });
    await this.afterPend?.(ctx);
    await this.#send(ctx, row, callId);
  }

  async resume(ctx: TurnContext, pending: PendingRow[]): Promise<void> {
    await this.onResume?.(ctx, pending);
    for (const row of pending) {
      const callId = (row.payload as { callId: string }).callId;
      if (row.attempts > this.maxResends) {
        await ctx.finish("failed", `error: the model call ${callId} did not return after ${row.attempts - 1} retries`);
        return;
      }
      await this.#send(ctx, row, callId);
    }
  }

  async #send(ctx: TurnContext, row: PendingRow, callId: string): Promise<void> {
    const send = this.sent.filter((s) => s.callId === callId).length + 1;
    this.sent.push({ turnId: ctx.turnId, callId, send });
    await ctx.host.fetch(new Request(`http://model.test/${callId}`));
    if (!this.answers) return;
    await ctx.settle(row.id, "reply");
    await ctx.appendMessage("assistant", `reply to ${ctx.input}`);
    await ctx.finish("done", "ok");
  }
}

export interface WorldOptions {
  sessions?: string[];
  driver?: TurnDriver;
  config?: Partial<RuntimeConfig>;
  jobs?: Record<string, JobFn>;
  /** Start the sweeper's cron. Default: a tick every minute and a sweep every 10 minutes. */
  cron?: { tickMs: number; sweepMs: number } | false;
}

/** The actors of one test: sessions, the sweeper and the profile stub, on one backend. */
export interface World {
  readonly backend: ActorBackend;
  readonly config: RuntimeConfig;
  readonly driver: ScriptedDriver;
  readonly sessions: string[];
  /** Send an inbound message to a session. */
  receive(session: string, request: string, input?: string, principal?: string): Promise<unknown>;
  /** Read rows of a table of an actor. */
  rows(actor: string, table: string, where?: string): Array<Record<string, unknown>>;
  /** Start a clean activation of each actor and wait for the background work. */
  warm(): Promise<void>;
}

export function createWorld(backend: ActorBackend, opts: WorldOptions = {}): World {
  const sessions = opts.sessions ?? ["s1"];
  const config = resolveConfig({
    minDelayMs: 30_000,
    horizonMs: 120_000,
    sweeperTarget: "actor:sweeper",
    profileTarget: "actor:profile",
    ...opts.config,
  });
  const driver = (opts.driver as ScriptedDriver | undefined) ?? new ScriptedDriver();
  const deps = { clock: backend.clock, driver, config, ...(opts.jobs ? { jobs: opts.jobs } : {}) };

  backend.defineActor("sweeper", (h) => new SweeperActor(h, { clock: backend.clock, config }));
  backend.defineActor("profile", (h) => new ProfileStub(h));
  for (const s of sessions) backend.defineActor(s, (h) => new SessionActor(h, deps));
  const cron = opts.cron === undefined ? { tickMs: 60_000, sweepMs: 600_000 } : opts.cron;
  if (cron) {
    backend.cron("sweeper", "tick", cron.tickMs);
    backend.cron("sweeper", "sweep", cron.sweepMs);
  }

  return {
    backend,
    config,
    driver,
    sessions,
    receive: (session, request, input = "hello", principal = "user-1") =>
      backend.call(session, "receive", { principal, session, request, input }),
    rows: (actor, table, where) => backend.query(actor, `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""} ORDER BY rowid`),
    async warm() {
      for (const s of sessions) await backend.call(s, "tail");
      await backend.call("sweeper", "noop").catch(() => {});
      await backend.call("profile", "reconcile");
      await backend.settle();
    },
  };
}
