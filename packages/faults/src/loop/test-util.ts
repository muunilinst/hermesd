import { describe } from "node:test";
import { NODE_CONFIGS, type NodeBackendOptions } from "../actor/node-backend.ts";
import { createLoopWorld, type LoopWorld, type LoopWorldOptions } from "./world.ts";

/** Run a body on each Node configuration, with a fresh world. */
export function eachLoopWorld(
  title: string,
  fn: (use: (opts: LoopWorldOptions | (() => LoopWorldOptions), body: (w: LoopWorld) => Promise<void>) => () => Promise<void>, cfg: NodeBackendOptions) => void,
): void {
  for (const cfg of NODE_CONFIGS) {
    describe(`${title} [node/${cfg.mode}]`, () => {
      const use = (opts: LoopWorldOptions | (() => LoopWorldOptions), body: (w: LoopWorld) => Promise<void>) => async () => {
        const w = await createLoopWorld(cfg, typeof opts === "function" ? opts() : opts);
        try {
          await body(w);
        } finally {
          w.b.close();
        }
      };
      fn(use, cfg);
    });
  }
}
