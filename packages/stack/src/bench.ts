import type { ActorName, MeterSnapshot, Stack, StackFactory } from "./types.ts";
import { benchScript } from "./world.ts";

/**
 * Milestone 1 step 8 (guide 10.2): measure a turn at the Host interface on one host.
 *
 * The workload is `turns` turns against the scripted model, every `toolEvery`-th one
 * with a terminal call. A warm-up turn is not counted. Then `coldSamples` cold wakes:
 * the session is evicted and the next input arrives; the wake latency is the time from
 * the send to the model request, minus the same on a warm session.
 */
export interface BenchOptions {
  turns?: number;
  toolEvery?: number;
  modelDelayMs?: number;
  coldSamples?: number;
}

export interface Dist {
  median: number;
  p95: number;
  n: number;
}

export interface BenchResult {
  host: string;
  turns: number;
  modelCallsPerTurn: number;
  modelDelayMs: number;
  /** Per turn, summed over the session, sweeper and profile actors. */
  perTurn: {
    events: number;
    tx: number;
    statements: number;
    rowsChanged: number;
    commits: number;
    arms: number;
    sidecarCalls: number;
    /** Wall time with any work or I/O open, the model call included (what Durable Objects bill as duration). */
    busyMs: number;
    /** The same without the model wait. */
    busyExclModelMs: number;
  };
  /** The session actor alone, per turn. */
  session: MeterSnapshot;
  /** Wall time from send to reply. */
  turnMs: Dist;
  /** turnMs minus the model delay of the turn's calls: what the port adds. */
  overheadMs: Dist;
  /** Send to the model request, on a warm session. */
  warmToModelMs: Dist;
  /** Send to the model request, right after an eviction. */
  coldToModelMs: Dist;
}

export function dist(xs: number[]): Dist {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  return { median: round(at(0.5)), p95: round(at(0.95)), n: s.length };
}

const round = (x: number) => Math.round(x * 100) / 100;
const ACTORS: ActorName[] = ["s1", "sweeper", "profile"];

function per(m: MeterSnapshot, n: number): MeterSnapshot {
  const sidecars: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.sidecars)) sidecars[k] = round(v / n);
  return {
    activations: m.activations,
    events: round(m.events / n),
    tx: round(m.tx / n),
    statements: round(m.statements / n),
    rowsChanged: m.rowsChanged < 0 ? -1 : round(m.rowsChanged / n),
    commits: round(m.commits / n),
    arms: round(m.arms / n),
    disarms: round(m.disarms / n),
    fetches: round(m.fetches / n),
    sidecars,
    busyMs: round(m.busyMs / n),
    busyExclModelMs: round(m.busyExclModelMs / n),
  };
}

async function timedTurn(s: Stack, input: string, seen: number): Promise<{ turnMs: number; toModelMs: number }> {
  const before = (await s.modelArrivals()).length;
  const t0 = Date.now();
  await s.send(input);
  await s.waitReplies(seen + 1, 60_000);
  const turnMs = Date.now() - t0;
  const first = (await s.modelArrivals())[before];
  return { turnMs, toModelMs: first ? first.at - t0 : NaN };
}

export async function runBench(make: StackFactory, opts: BenchOptions = {}): Promise<BenchResult> {
  const turns = opts.turns ?? 20;
  const toolEvery = opts.toolEvery ?? 2;
  const modelDelayMs = opts.modelDelayMs ?? 0;
  const coldSamples = opts.coldSamples ?? 5;
  const total = 1 + turns + coldSamples * 2;
  const script = benchScript(total, 0).slice(0, 1).concat(benchScript(turns, toolEvery), benchScript(coldSamples * 2, 0));
  const s = await make({ script, modelDelayMs });
  try {
    let seen = 0;
    await timedTurn(s, "warm-up", seen++);
    await s.resetMeters();
    const arrivals0 = (await s.modelArrivals()).length;
    const turnMs: number[] = [];
    const overhead: number[] = [];
    const warm: number[] = [];
    for (let i = 0; i < turns; i++) {
      const a = (await s.modelArrivals()).length;
      const r = await timedTurn(s, `turn ${i}`, seen++);
      const calls = (await s.modelArrivals()).length - a;
      turnMs.push(r.turnMs);
      overhead.push(r.turnMs - calls * modelDelayMs);
      warm.push(r.toModelMs);
    }
    const meters = await Promise.all(ACTORS.map((a) => s.meter(a)));
    const modelCalls = (await s.modelArrivals()).length - arrivals0;
    const cold: number[] = [];
    for (let i = 0; i < coldSamples; i++) {
      await timedTurn(s, `prime ${i}`, seen++);
      await s.evict("s1");
      cold.push((await timedTurn(s, `cold ${i}`, seen++)).toModelMs);
    }
    const sum = (f: (m: MeterSnapshot) => number) => round(meters.reduce((acc, m) => acc + f(m), 0) / turns);
    return {
      host: s.host,
      turns,
      modelCallsPerTurn: round(modelCalls / turns),
      modelDelayMs,
      perTurn: {
        events: sum((m) => m.events),
        tx: sum((m) => m.tx),
        statements: sum((m) => m.statements),
        rowsChanged: meters.some((m) => m.rowsChanged < 0) ? -1 : sum((m) => m.rowsChanged),
        commits: sum((m) => m.commits),
        arms: sum((m) => m.arms),
        sidecarCalls: sum((m) => Object.values(m.sidecars).reduce((a, b) => a + b, 0)),
        busyMs: sum((m) => m.busyMs),
        busyExclModelMs: sum((m) => m.busyExclModelMs),
      },
      session: per(meters[0]!, turns),
      turnMs: dist(turnMs),
      overheadMs: dist(overhead),
      warmToModelMs: dist(warm),
      coldToModelMs: dist(cold),
    };
  } finally {
    await s.close();
  }
}
