import type { Executor } from "@hermesd/executor-protocol";
import { CallerCrashedError, MessageDelayedError, ReplyLostError } from "./errors.ts";

export type ExecutorMethod = "prepare" | "start" | "status" | "cancel" | "ack" | "fence" | "describe";

/** One message that the caller sent. */
export interface SentMessage {
  index: number;
  method: ExecutorMethod;
  args: unknown[];
}

/** A message that the network holds back. `deliver` sends it later. */
export interface DelayedMessage {
  readonly message: SentMessage;
  deliver(): Promise<unknown>;
}

type Fault = "drop_reply" | "crash_caller" | "delay";

/**
 * A link between a caller and the executor that can inject faults.
 *
 * - `dropReplyNext`: the call has its effect, the reply is lost.
 * - `crashCallerAfterSendNext`: the call has its effect, then the caller
 *   process dies. The test then continues as a new caller process.
 * - `delayNext`: the message does not arrive now. The caller times out.
 *   The returned handle delivers it later.
 * - `copy`: build a duplicate of any message that was sent before.
 *
 * Every fault applies once, to the next call of the named method.
 */
export class FaultLink implements Executor {
  readonly sent: SentMessage[] = [];
  readonly #target: () => Executor;
  readonly #plan: Array<{ method: ExecutorMethod; fault: Fault; holder?: { message?: SentMessage } }> = [];

  /** `target` is a function, so a new owner node can take the place of the cell. */
  constructor(target: () => Executor) {
    this.#target = target;
  }

  dropReplyNext(method: ExecutorMethod): void {
    this.#plan.push({ method, fault: "drop_reply" });
  }

  crashCallerAfterSendNext(method: ExecutorMethod): void {
    this.#plan.push({ method, fault: "crash_caller" });
  }

  /** The message is held. Call `deliver()` on the result after the caller timed out. */
  delayNext(method: ExecutorMethod): { deliverLast(): DelayedMessage } {
    const holder: { message?: SentMessage } = {};
    this.#plan.push({ method, fault: "delay", holder });
    return {
      deliverLast: () => {
        if (!holder.message) throw new Error("no message was delayed yet");
        return this.copy(holder.message.index);
      },
    };
  }

  /** A duplicate of a message that was sent before. */
  copy(index: number): DelayedMessage {
    const message = this.sent[index];
    if (!message) throw new Error(`no message with index ${index}`);
    return { message, deliver: () => this.#deliver(message) };
  }

  /** The last message of a method. */
  lastSent(method: ExecutorMethod): SentMessage {
    const found = [...this.sent].reverse().find((m) => m.method === method);
    if (!found) throw new Error(`no ${method} was sent`);
    return found;
  }

  #deliver(message: SentMessage): Promise<unknown> {
    const target = this.#target() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return target[message.method]!(...message.args);
  }

  async #call(method: ExecutorMethod, args: unknown[]): Promise<unknown> {
    const message: SentMessage = { index: this.sent.length, method, args };
    this.sent.push(message);
    const at = this.#plan.findIndex((p) => p.method === method);
    const planned = at >= 0 ? this.#plan.splice(at, 1)[0] : undefined;
    if (planned?.fault === "delay") {
      planned.holder!.message = message;
      throw new MessageDelayedError(`${method} was delayed`);
    }
    const reply = await this.#deliver(message);
    if (planned?.fault === "drop_reply") throw new ReplyLostError(`the reply of ${method} was lost`);
    if (planned?.fault === "crash_caller") throw new CallerCrashedError(`the caller crashed after ${method}`);
    return reply;
  }

  prepare: Executor["prepare"] = (req) => this.#call("prepare", [req]) as ReturnType<Executor["prepare"]>;
  start: Executor["start"] = (opId, epoch) => this.#call("start", [opId, epoch]) as ReturnType<Executor["start"]>;
  status: Executor["status"] = (opId) => this.#call("status", [opId]) as ReturnType<Executor["status"]>;
  cancel: Executor["cancel"] = (opId, epoch) => this.#call("cancel", [opId, epoch]) as ReturnType<Executor["cancel"]>;
  ack: Executor["ack"] = (opId, epoch) => this.#call("ack", [opId, epoch]) as ReturnType<Executor["ack"]>;
  fence: Executor["fence"] = (session, epoch) => this.#call("fence", [session, epoch]) as ReturnType<Executor["fence"]>;
  describe: Executor["describe"] = (workspace) => this.#call("describe", [workspace]) as ReturnType<Executor["describe"]>;
}
