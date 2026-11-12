import { ModelRig } from "@hermesd/executor-model";
import type { OpId } from "@hermesd/executor-protocol";
import type { Host } from "@hermesd/host";
import { ProfileActor } from "@hermesd/profile-actor";
import { SweeperActor, resolveConfig, type ActorBehavior, type Clock, type RuntimeConfig } from "@hermesd/runtime";
import { ScriptedModel, createSessionActor, executorHandler, type ModelStep, type ScriptedToolCall } from "@hermesd/session-actor";
import type { ActorName, ModelArrival, StackOptions, StackReply } from "./types.ts";

/**
 * The parts of the milestone 1 world that do not depend on the host. Each platform's
 * glue builds the three actors from `actorFactory` on its own Host, and keeps the three
 * services (model, executor, gateway) somewhere that outlives an actor restart.
 *
 * This file uses no Node API: it runs in workerd as it is.
 */

/** Sidecar and target names. The same on every host. */
export const NAMES = {
  session: "s1",
  sweeper: "actor:sweeper",
  profile: "actor:profile",
  executor: "executor",
  gateway: "gateway",
  actorTarget: (id: string) => `actor:${id}`,
} as const;

/** The sidecar name an actor uses for another actor, mapped back to the actor. */
export function actorOfTarget(target: string): ActorName | undefined {
  if (target === NAMES.sweeper) return "sweeper";
  if (target === NAMES.profile) return "profile";
  if (target === NAMES.actorTarget(NAMES.session)) return "s1";
  return undefined;
}

export function worldConfig(opts: Pick<StackOptions, "minDelayMs" | "horizonMs">): RuntimeConfig {
  return resolveConfig({
    minDelayMs: opts.minDelayMs ?? 1_000,
    horizonMs: opts.horizonMs ?? 10_000,
    sweeperTarget: NAMES.sweeper,
    profileTarget: NAMES.profile,
    actorTarget: NAMES.actorTarget,
  });
}

/** Build one actor of the world on `host`. */
export function actorFactory(name: ActorName, opts: StackOptions, clock: Clock): (host: Host) => ActorBehavior {
  const config = worldConfig(opts);
  switch (name) {
    case "sweeper":
      return (h) => new SweeperActor(h, { clock, config });
    case "profile":
      return (h) => new ProfileActor(h, {});
    case "s1":
      return (h) =>
        createSessionActor(h, {
          clock,
          runtime: config,
          loop: {
            replyTarget: NAMES.gateway,
            profileTarget: NAMES.profile,
            executorTarget: NAMES.executor,
            // The terminal tool runs a scripted command: the model passes the command spec as JSON text.
            buildCommand: (a) => ({ argv: ["scripted", a.command] }),
          },
        });
  }
}

/** The scripted model, with a fixed latency per answer and the arrival time of each request. */
export class ModelService {
  readonly model: ScriptedModel;
  readonly arrivals: ModelArrival[] = [];
  readonly #delayMs: number;

  constructor(script: ModelStep[], delayMs = 0) {
    this.model = new ScriptedModel(script);
    this.#delayMs = delayMs;
  }

  readonly fetch = async (req: Request, signal?: AbortSignal): Promise<Response> => {
    this.arrivals.push({ at: Date.now(), callId: req.headers.get("idempotency-key") });
    if (this.#delayMs > 0) await sleep(this.#delayMs, signal);
    return this.model.fetch(req, signal);
  };

  release(name: string): void {
    this.model.release(name);
  }
}

/** The executor: the in-memory executor model, one workspace with a running VM. */
export class ExecutorService {
  readonly rig = new ModelRig();
  readonly #ops = new Set<OpId>();
  readonly #handler: (method: string, params: unknown) => Promise<unknown>;
  readonly ready: Promise<void>;

  constructor() {
    this.#handler = executorHandler(this.rig.link());
    this.ready = this.rig.cell.startVm().then(() => undefined);
  }

  readonly handle = async (method: string, params: unknown): Promise<unknown> => {
    await this.ready;
    if (method === "start") this.#ops.add((params as { opId: OpId }).opId);
    return this.#handler(method, params);
  };

  /** Commands that ran in the guest, counted per operation, so a second run shows. */
  runs(): number {
    let n = 0;
    for (const op of this.#ops) n += this.rig.runCount(op);
    return n;
  }
}

/** The gateway: it keeps each reply once, by its idempotency key. */
export class GatewayService {
  readonly replies: StackReply[] = [];
  deliveries = 0;
  readonly #seen = new Set<string>();

  readonly handle = async (method: string, params: unknown): Promise<unknown> => {
    if (method !== "deliver") throw new Error(`gateway: unknown method ${method}`);
    const p = params as { text: string; kind: string; turn: string; idempotencyKey: string };
    this.deliveries += 1;
    if (!this.#seen.has(p.idempotencyKey)) {
      this.#seen.add(p.idempotencyKey);
      this.replies.push({ text: p.text, kind: p.kind, turn: p.turn, key: p.idempotencyKey, at: Date.now() });
    }
    return { ok: true };
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}

// ------------------------------------------------------------ scripts

/** A model tool call to `terminal` with a scripted command (see `ScriptedCommands`). */
export function terminalCall(spec: { stdout?: string; exitCode?: number; hold?: string } = {}, id?: string): ScriptedToolCall {
  return { name: "terminal", arguments: { command: JSON.stringify(spec) }, ...(id ? { id } : {}) };
}

/**
 * The bench workload: `turns` turns, each either a plain reply or one terminal call
 * and then a reply (every `toolEvery`-th turn uses the tool; 0 means never).
 */
export function benchScript(turns: number, toolEvery = 2): ModelStep[] {
  const steps: ModelStep[] = [];
  for (let i = 0; i < turns; i++) {
    if (toolEvery > 0 && i % toolEvery === toolEvery - 1) {
      steps.push({ toolCalls: [terminalCall({ stdout: `out ${i}\n` })] });
      steps.push({ reply: `done ${i}` });
    } else {
      steps.push({ reply: `reply ${i}` });
    }
  }
  return steps;
}

/** Wrap an actor so that the meter sees each event the platform gives it. */
export function meteredBehavior(b: ActorBehavior, meter: { event<T>(fn: () => Promise<T>, label?: string): Promise<T> }): ActorBehavior {
  const out: ActorBehavior = {
    call: (m, p) => {
      const request = m === "receive" ? (p as { request?: unknown } | null)?.request : undefined;
      return meter.event(() => b.call(m, p), `call:${m}${typeof request === "string" ? `:${request}` : ""}`);
    },
  };
  if (b.activate) out.activate = () => b.activate!();
  if (b.alarm) out.alarm = () => meter.event(() => b.alarm!(), "alarm");
  if (b.cron) out.cron = (n) => meter.event(() => b.cron!(n), `cron:${n}`);
  return out;
}
