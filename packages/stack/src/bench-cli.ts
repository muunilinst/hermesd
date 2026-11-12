/**
 * bun packages/stack/src/bench-cli.ts [node|workerd|rivet ...] [--turns N] [--model-ms M] [--out file]
 * Prints one JSON object per host, with the Durable Objects cost per user-month.
 */
import { writeFileSync } from "node:fs";
import { runBench, type BenchResult } from "./bench.ts";
import { DEFAULT_USAGE, PRICES, durableObjectsCost } from "./cost.ts";
import type { StackFactory } from "./types.ts";

const args = process.argv.slice(2);
const flag = (n: string, d: number) => {
  const i = args.indexOf(n);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const outAt = args.indexOf("--out");
const hosts = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));

async function factory(host: string): Promise<StackFactory> {
  switch (host) {
    case "node":
      return (await import("./node.ts")).createNodeStack;
    case "workerd":
      return (await import(`./${"workerd"}.ts`)).createWorkerdStack;
    case "rivet":
      return (await import(`./${"rivet"}.ts`)).createRivetStack;
    default:
      throw new Error(`unknown host ${host}`);
  }
}

const results: Array<BenchResult & { costUsdPerUserMonth: ReturnType<typeof durableObjectsCost> }> = [];
for (const h of hosts.length > 0 ? hosts : ["node"]) {
  const r = await runBench(await factory(h), { turns: flag("--turns", 20), modelDelayMs: flag("--model-ms", 0), coldSamples: flag("--cold", 5) });
  results.push({ ...r, costUsdPerUserMonth: durableObjectsCost(r) });
  console.log(JSON.stringify(results.at(-1), null, 2));
}
const report = { at: new Date().toISOString(), usage: DEFAULT_USAGE, prices: PRICES, results };
if (outAt >= 0) writeFileSync(args[outAt + 1]!, JSON.stringify(report, null, 2) + "\n");
process.exit(0);
