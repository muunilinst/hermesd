import assert from "node:assert/strict";
import { FaultLink, ModelRig, type CommandSpec } from "@hermesd/executor-model";
import { ProfileActor } from "@hermesd/profile-actor";
import { SweeperActor, resolveConfig, type RuntimeConfig } from "@hermesd/runtime";
import {
  DEFAULT_MIGRATIONS,
  ScriptedModel,
  createSessionActor,
  executorHandler,
  type LoopConfig,
  type MigrationSet,
  type ModelStep,
  type ScriptedToolCall,
} from "@hermesd/session-actor";
import type { ActorBackend } from "../actor/backend.ts";
import { createNodeBackend, type NodeBackendOptions } from "../actor/node-backend.ts";

/**
 * The world of the loop tests: a session actor, the sweeper, the profile
 * actor, a scripted model behind `Host.fetch`, the executor model behind the
 * sidecar `executor`, and a gateway sidecar that receives the replies.
 */

export interface Reply {
  text: string;
  kind: string;
  turn: string;
  key: string;
}

export interface LoopWorldOptions {
  script: ModelStep[];
  loop?: Partial<LoopConfig>;
  runtime?: Partial<RuntimeConfig>;
  cron?: boolean;
  /** The code version under test. Read at every activation, so a test can swap it. */
  code?: { migrations: MigrationSet };
  /** Use the LIKE fallback in the profile actor. */
  forceLike?: boolean;
}

export interface LoopWorld {
  readonly b: ActorBackend;
  readonly model: ScriptedModel;
  readonly rig: ModelRig;
  /** The link between the actors and the executor model. Faults are set here. */
  readonly link: FaultLink;
  /** Replies the user received, each key once. */
  readonly replies: Reply[];
  /** All deliveries to the gateway, with duplicates. */
  readonly deliveries: number;
  readonly code: { migrations: MigrationSet };
  readonly config: RuntimeConfig;
  send(input: string, request?: string): Promise<unknown>;
  stop(): Promise<unknown>;
  rows(table: string, where?: string): Array<Record<string, unknown>>;
  /** Wait until `pred` holds. Lets queued work run. Fails after `max` rounds. */
  until(pred: () => boolean, what: string, max?: number): Promise<void>;
  /** Move the clock past the wake delay of the runtime, so obligations fire. */
  wakeAll(): Promise<void>;
  /** Check the rows of the session actor against the rules of the loop. */
  assertConsistent(): void;
}

/** The terminal tool runs a scripted command: the model passes the command spec as JSON text. */
export const scriptedTerminal: Partial<LoopConfig> = {
  buildCommand: (a) => ({ argv: ["scripted", a.command] }),
};

/** A model tool call to `terminal` with a scripted command. */
export function term(spec: CommandSpec = {}, id?: string): ScriptedToolCall {
  return { name: "terminal", arguments: { command: JSON.stringify(spec) }, ...(id ? { id } : {}) };
}

export async function tick(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}

export async function createLoopWorld(node: NodeBackendOptions, opts: LoopWorldOptions): Promise<LoopWorld> {
  const model = new ScriptedModel(opts.script);
  const b = createNodeBackend({ ...node, fetch: (req, signal) => model.fetch(req, signal) });
  const rig = new ModelRig();
  await rig.cell.startVm();
  const link = rig.link();
  b.registerSidecar("executor", executorHandler(link));
  const replies: Reply[] = [];
  const seen = new Set<string>();
  const world = { deliveries: 0 };
  b.registerSidecar("gateway", async (method, params) => {
    if (method !== "deliver") throw new Error(`gateway: unknown method ${method}`);
    const p = params as { text: string; kind: string; turn: string; idempotencyKey: string };
    world.deliveries += 1;
    if (!seen.has(p.idempotencyKey)) {
      seen.add(p.idempotencyKey);
      replies.push({ text: p.text, kind: p.kind, turn: p.turn, key: p.idempotencyKey });
    }
    return { ok: true };
  });

  const code = opts.code ?? { migrations: DEFAULT_MIGRATIONS };
  const config = resolveConfig({
    minDelayMs: 30_000,
    horizonMs: 120_000,
    sweeperTarget: "actor:sweeper",
    profileTarget: "actor:profile",
    ...opts.runtime,
  });
  b.defineActor("sweeper", (h) => new SweeperActor(h, { clock: b.clock, config }));
  b.defineActor("profile", (h) => new ProfileActor(h, { forceLike: opts.forceLike ?? false }));
  b.defineActor("s1", (h) =>
    createSessionActor(h, {
      clock: b.clock,
      runtime: config,
      migrations: code.migrations,
      loop: { replyTarget: "gateway", profileTarget: "actor:profile", ...opts.loop },
    }),
  );
  if (opts.cron !== false) {
    b.cron("sweeper", "tick", 60_000);
    b.cron("sweeper", "sweep", 600_000);
  }
  await b.call("profile", "register_session", { session: "s1" });

  const w: LoopWorld = {
    b,
    model,
    rig,
    link,
    replies,
    get deliveries() {
      return world.deliveries;
    },
    code,
    config,
    send: (input, request = `req-${Math.random().toString(36).slice(2)}`) =>
      b.call("s1", "receive", { principal: "user-1", session: "s1", request, input }),
    stop: () => b.call("s1", "stop"),
    rows: (table, where) => b.query("s1", `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""} ORDER BY rowid`),
    async until(pred, what, max = 400) {
      // Rounds are cheap, but a busy machine runs them slowly: wait for the rounds and for 20 s.
      const deadline = Date.now() + 20_000;
      for (let i = 0; i < max || Date.now() < deadline; i++) {
        if (pred()) return;
        await tick(2);
      }
      assert.fail(`timed out waiting for: ${what}`);
    },
    async wakeAll() {
      await b.clock.advance(config.minDelayMs + 1_000);
    },
    assertConsistent() {
      const open = new Set(w.rows("turns", "status = 'open'").map((r) => r.id));
      for (const t of w.rows("turns").filter((r) => r.status !== "open")) {
        const id = t.id as string;
        assert.deepEqual(w.rows("pending_rows", `turn_id = '${id}' AND status = 'pending'`), [], `turn ${id} ended with a pending row`);
        assert.deepEqual(w.rows("pending_call", `turn_id = '${id}' AND status = 'pending'`), [], `turn ${id} ended with a pending call`);
        assert.deepEqual(w.rows("pending_op", `turn_id = '${id}' AND status = 'pending' AND discard = 0`), [], `turn ${id} ended with a pending op`);
        assert.deepEqual(w.rows("wake_obligations", `turn_id = '${id}' AND state = 'open'`), [], `turn ${id} ended with an open obligation`);
      }
      assert.equal(open.size <= 1, true, "at most one open turn");
      // A tool call and its result are never split.
      const messages = w.rows("messages", "active = 1");
      const asked = new Set(w.rows("clarify_question", "status = 'open'").map((r) => r.tool_call_uid));
      for (const m of messages) {
        if (m.role !== "assistant" || typeof m.tool_calls !== "string") continue;
        const calls = JSON.parse(m.tool_calls) as Array<{ id: string }>;
        // While a clarify question is open, the calls behind it wait.
        for (const c of calls) {
          const answered = messages.some((x) => x.role === "tool" && x.tool_call_id === c.id);
          assert.equal(answered || asked.size > 0 || open.size > 0, true, `tool call ${c.id} has no result`);
        }
      }
      const uids = messages.map((m) => m.message_uid);
      assert.equal(new Set(uids).size, uids.length, "a message uid appears twice");
    },
  };
  return w;
}
