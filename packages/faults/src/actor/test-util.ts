import { describe } from "node:test";
import type { ActorBackend } from "./backend.ts";
import { createNodeBackend, NODE_CONFIGS, type NodeBackendOptions } from "./node-backend.ts";

/** Wraps a test body: makes a fresh backend, runs the body, closes the backend. */
export type Use = (body: (b: ActorBackend) => Promise<void>) => () => Promise<void>;

/**
 * Run the same tests on each Node configuration (Durable Objects rules and
 * Rivet rules). `fn` gets `use` to build test bodies and the configuration.
 */
export function eachNode(
  title: string,
  fn: (use: Use, cfg: NodeBackendOptions) => void,
  configs: ReadonlyArray<NodeBackendOptions> = NODE_CONFIGS,
): void {
  for (const cfg of configs) {
    const label = `${cfg.mode}${cfg.retryFailedAlarms === false ? ", alarm retry off" : ""}`;
    describe(`${title} [node/${label}]`, () => {
      const use: Use = (body) => async () => {
        const b = createNodeBackend(cfg);
        try {
          await body(b);
        } finally {
          b.close();
        }
      };
      fn(use, cfg);
    });
  }
}

/** A promise that never settles. A test uses it to stop a flow after it crashed the actor. */
export function never(): Promise<never> {
  return new Promise<never>(() => {});
}
