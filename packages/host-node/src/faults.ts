/** Named places where a test can crash an actor or run a hook. */
export type FaultPoint =
  | "arm:before" // before the timer is set
  | "arm:after" // the timer is durable, the caller has not seen the result
  | "disarm:before" // before a timer is removed
  | "tx:before" // before the transaction runs
  | "tx:before-commit" // the function ran, the rows are not committed yet (a crash rolls them back)
  | "tx:after" // in the write buffer, not yet durable on Durable Objects
  | "commit:before"
  | "commit:after" // the rows are durable
  | "fetch:before"
  | "fetch:after" // the request left, the response is not seen
  | "sidecar:before"
  | "sidecar:after"
  | "reply:before"; // the call finished and is durable, the reply has not left

/** The kind of event that the actor is handling at the fault point. */
export type EventKind = "call" | "alarm" | "cron" | "activate";

/** Which fault point to match. All set fields must match. */
export interface PointRule {
  /** The actor key. */
  actor: string;
  point: FaultPoint;
  event?: EventKind;
  /** For `call` events: the method name. */
  method?: string;
  /** For `sidecar` points: `<sidecar name>.<method>`, for example `actor:profile.index`. */
  detail?: string;
  /** Act on the n-th match (1-based). Default 1. Each rule acts once. */
  nth?: number;
}

export interface PointContext {
  event?: EventKind | undefined;
  method?: string | undefined;
  detail?: string | undefined;
}

export type PointAction = { crash: true } | { hook: () => void | Promise<void> };

interface Installed {
  rule: PointRule;
  action: PointAction;
  seen: number;
  done: boolean;
}

/** The rules that a test installed. The platform asks this at every fault point. */
export class FaultHooks {
  #rules: Installed[] = [];
  #armFailures = new Map<string, number>();

  /** Crash the actor at the point. */
  crashAt(rule: PointRule): void {
    this.#rules.push({ rule, action: { crash: true }, seen: 0, done: false });
  }

  /** Run `hook` at the point, and wait for it. The actor does not crash. */
  onPoint(rule: PointRule, hook: () => void | Promise<void>): void {
    this.#rules.push({ rule, action: { hook }, seen: 0, done: false });
  }

  /** Make the next `times` calls of `arm` fail. */
  failArm(actor: string, times = 1): void {
    this.#armFailures.set(actor, times);
  }

  /** True once if a failure is queued for this actor. */
  consumeArmFailure(actor: string): boolean {
    const n = this.#armFailures.get(actor) ?? 0;
    if (n <= 0) return false;
    this.#armFailures.set(actor, n - 1);
    return true;
  }

  /** Find the actions that fire now. Several rules can fire at one point. */
  match(actor: string, point: FaultPoint, ctx: PointContext): PointAction[] {
    const hits: PointAction[] = [];
    for (const r of this.#rules) {
      if (r.done) continue;
      const q = r.rule;
      if (q.actor !== actor && q.actor !== "*") continue;
      if (q.point !== point) continue;
      if (q.event !== undefined && q.event !== ctx.event) continue;
      if (q.method !== undefined && q.method !== ctx.method) continue;
      if (q.detail !== undefined && q.detail !== ctx.detail) continue;
      r.seen += 1;
      if (r.seen === (q.nth ?? 1)) {
        r.done = true;
        hits.push(r.action);
      }
    }
    return hits;
  }

  /** Remove all rules. */
  clear(): void {
    this.#rules = [];
    this.#armFailures.clear();
  }
}
