// The part of the `cloudflare:workers` module that the workerd worker uses. The
// module exists only inside workerd; this keeps the worker type-checked without
// @cloudflare/workers-types.
declare module "cloudflare:workers" {
  export interface DurableObjectState {
    id: { name?: string | undefined; toString(): string };
    storage: {
      sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
      transactionSync<T>(fn: () => T): T;
      sync(): Promise<void>;
      setAlarm(t: number | Date): Promise<void>;
      getAlarm(): Promise<number | null>;
      deleteAlarm(): Promise<void>;
    };
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
    abort(reason?: string): never;
  }
  export class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
