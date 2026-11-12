import type { ActorName, MeterSnapshot, Stack, StackFactory, StackReply } from "./types.ts";
import { benchScript } from "./world.ts";

/**
 * Milestone 1 step 8 (guide 10.2): measure a turn at the Host interface on one host.
 *
 * The workload is `turns` turns against the scripted model, every `toolEvery`-th one
 * with a terminal call. A warm-up turn is not counted. Then `coldSamples` cold wakes:
 * the session is evicted (which does not wake it) and the send that wakes it is timed;
 * the wake latency is the time from that send to the model request. A sample counts only if
 * the timed send caused the activation: after the eviction `s1` was activated exactly once, its
 * first event was the `receive` of the timed request (named by its request id), and the epoch
 * rose. An activation by anything else first (an alarm, a sweeper call, a cron) rejects the sample
 * and it is taken again, up to `COLD_ATTEMPTS` times per sample.
 *
 * Definitions:
 * - Turn latency: the gateway stamps each reply when it receives it (`StackReply.at`).
 *   The latency is that stamp minus the time just before the send. The polling of
 *   `waitReplies` is not in it.
 * - Percentiles: linear interpolation between order statistics, rank = q * (n - 1) on the
 *   sorted samples (numpy's default, Python `statistics.quantiles(method="inclusive")`).
 *   For n = 20 the median is the mean of the 10th and 11th samples and p95 is
 *   `s[18] + 0.05 * (s[19] - s[18])`, not the maximum. The upstream side must use the same.
 * - Drain: before the meters are reset and before they are read, the bench waits until `s1`
 *   has no unsent outbox row, no open turn and no pending call, op or row, and the profile
 *   actor's applied-index count has stopped moving.
 * - A sample is valid only if its reply is the scripted text of that turn with kind
 *   `reply`, no other reply arrived, and the model received the calls the script has for it.
 */
export interface BenchOptions {
  turns?: number;
  toolEvery?: number;
  modelDelayMs?: number;
  coldSamples?: number;
}

/** `median` and `p95` are null when there are no samples (n = 0). */
export interface Dist {
  median: number | null;
  p95: number | null;
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
    /** Rows the adapters wrote themselves (`wake_timers`, `host_meta`). Zero where the host does not report them. */
    adapterRows: number;
    /** Platform timer calls of the adapters (`setAlarm`, `deleteAlarm`, `schedule.at`, `schedule.cancel`). */
    timerCalls: number;
    /** Wall time with any work or I/O open, the model call included (what Durable Objects bill as duration). */
    busyMs: number;
    /** The same without the model wait. */
    busyExclModelMs: number;
  };
  /** The session actor alone, per turn. */
  session: MeterSnapshot;
  /** Wall time from just before the send to the gateway receiving the reply. */
  turnMs: Dist;
  /** turnMs minus the model delay of the turn's calls: what the port adds. */
  overheadMs: Dist;
  /** Send to the model request, on a warm session. */
  warmToModelMs: Dist;
  /** Send to the model request, for the send that wakes an evicted session. */
  coldToModelMs: Dist;
}

/** Percentile `q` (0..1) by linear interpolation, rank = q * (n - 1). `xs` must be sorted. */
export function percentile(sorted: number[], q: number): number {
  const rank = q * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export function dist(xs: number[]): Dist {
  if (xs.some((x) => !Number.isFinite(x))) throw new Error(`dist: a sample is not finite: ${JSON.stringify(xs)}`);
  if (xs.length === 0) return { n: 0, median: null, p95: null };
  const s = [...xs].sort((a, b) => a - b);
  return { median: round(percentile(s, 0.5)), p95: round(percentile(s, 0.95)), n: s.length };
}

const round = (x: number) => Math.round(x * 100) / 100;
const ACTORS: ActorName[] = ["s1", "sweeper", "profile"];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Throws unless the options can produce a measurement. */
export function validateOptions(opts: BenchOptions): Required<BenchOptions> {
  const turns = opts.turns ?? 20;
  const toolEvery = opts.toolEvery ?? 2;
  const modelDelayMs = opts.modelDelayMs ?? 0;
  const coldSamples = opts.coldSamples ?? 5;
  const int = (name: string, v: number, min: number) => {
    if (!Number.isInteger(v) || v < min) throw new Error(`bench: ${name} must be an integer >= ${min}, got ${v}`);
  };
  int("turns", turns, 1);
  int("coldSamples", coldSamples, 0);
  int("toolEvery", toolEvery, 0);
  if (!Number.isFinite(modelDelayMs) || modelDelayMs < 0) throw new Error(`bench: modelDelayMs must be a finite number >= 0, got ${modelDelayMs}`);
  return { turns, toolEvery, modelDelayMs, coldSamples };
}

function per(m: MeterSnapshot, n: number): MeterSnapshot {
  const sidecars: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.sidecars)) sidecars[k] = round(v / n);
  return {
    activations: m.activations,
    firstEvents: [],
    events: round(m.events / n),
    tx: round(m.tx / n),
    statements: round(m.statements / n),
    rowsChanged: m.rowsChanged < 0 ? -1 : round(m.rowsChanged / n),
    commits: round(m.commits / n),
    arms: round(m.arms / n),
    disarms: round(m.disarms / n),
    fetches: round(m.fetches / n),
    sidecars,
    adapterRows: round(m.adapterRows / n),
    timerCalls: round(m.timerCalls / n),
    busyMs: round(m.busyMs / n),
    busyExclModelMs: round(m.busyExclModelMs / n),
  };
}

/** What a turn must show: the scripted reply and the number of model calls the script has for it. */
interface Expect {
  text: string;
  calls: number;
}

/** Each turn's expectation, in the order the turns are sent. */
function expectations(script: ReturnType<typeof benchScript>): Expect[] {
  const out: Expect[] = [];
  let calls = 0;
  for (const step of script) {
    calls += 1;
    if ("reply" in step && typeof step.reply === "string") {
      out.push({ text: step.reply, calls });
      calls = 0;
    }
  }
  return out;
}

interface Sample {
  turnMs: number;
  toModelMs: number;
  calls: number;
}

/** Send one input and measure it. The timer starts just before the send, the first event of the turn. */
async function timedTurn(s: Stack, input: string, idx: number, exp: Expect, request?: string): Promise<Sample> {
  const before = (await s.modelArrivals()).length;
  const t0 = Date.now();
  await s.send(input, request);
  const replies = await s.waitReplies(idx + 1, 60_000);
  const arrivals = await s.modelArrivals();
  const label = `turn ${idx} (${input})`;
  if (replies.length !== idx + 1) throw new Error(`bench: ${label}: expected ${idx + 1} replies, got ${replies.length}`);
  const r: StackReply = replies[idx]!;
  if (r.kind !== "reply") throw new Error(`bench: ${label}: reply kind is ${JSON.stringify(r.kind)}, not "reply": ${JSON.stringify(r.text).slice(0, 200)}`);
  if (r.text !== exp.text) throw new Error(`bench: ${label}: reply ${JSON.stringify(r.text).slice(0, 200)}, scripted ${JSON.stringify(exp.text)}`);
  const calls = arrivals.length - before;
  if (calls !== exp.calls) throw new Error(`bench: ${label}: ${calls} model calls, the script has ${exp.calls}`);
  const first = arrivals[before];
  if (!first) throw new Error(`bench: ${label}: the model saw no request`);
  return { turnMs: r.at - t0, toModelMs: first.at - t0, calls };
}

/** Rows of `sql` on `actor` as a count. */
async function count(s: Stack, actor: ActorName, sql: string): Promise<number> {
  return Number((await s.rows(actor, sql))[0]?.["n"] ?? 0);
}

/**
 * Wait until background work has ended: `s1` has no unsent outbox row, no open turn, no
 * pending model call, tool operation or runtime row, and the profile actor's count of applied
 * index updates has stopped moving (it must read the same twice, 100 ms apart).
 */
export async function drain(s: Stack, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  const open = [
    "SELECT count(*) AS n FROM outbox",
    "SELECT count(*) AS n FROM turns WHERE status = 'open'",
    "SELECT count(*) AS n FROM pending_rows WHERE status = 'pending'",
    "SELECT count(*) AS n FROM pending_call WHERE status = 'pending'",
    "SELECT count(*) AS n FROM pending_op WHERE status = 'pending'",
  ];
  let lastApplied = -1;
  for (;;) {
    let busy = 0;
    for (const q of open) busy += await count(s, "s1", q);
    if (busy === 0) {
      const applied = await count(s, "profile", "SELECT count(*) AS n FROM applied");
      if (applied === lastApplied) return;
      lastApplied = applied;
    } else {
      lastApplied = -1;
    }
    if (Date.now() > end) throw new Error(`bench: background work did not drain in ${timeoutMs} ms (${busy} open rows on s1)`);
    await sleep(busy === 0 ? 100 : 20);
  }
}

/** How many times a cold sample is taken again when something else woke the actor before the timed send. */
const COLD_ATTEMPTS = 3;

export async function runBench(make: StackFactory, options: BenchOptions = {}): Promise<BenchResult> {
  const { turns, toolEvery, modelDelayMs, coldSamples } = validateOptions(options);
  // Each cold attempt takes two scripted turns (prime and timed); rejected attempts use up theirs.
  const total = 1 + turns + coldSamples * 2 * COLD_ATTEMPTS;
  const script = benchScript(total, 0).slice(0, 1).concat(benchScript(turns, toolEvery), benchScript(coldSamples * 2 * COLD_ATTEMPTS, 0));
  const exp = expectations(script);
  if (exp.length !== total) throw new Error(`bench: the script has ${exp.length} turns, expected ${total}`);
  const s = await make({ script, modelDelayMs });
  try {
    let seen = 0;
    await timedTurn(s, "warm-up", seen, exp[seen]!);
    seen++;
    await drain(s);
    await s.resetMeters();
    const arrivals0 = (await s.modelArrivals()).length;
    const runs0 = await s.executorRuns();
    const turnMs: number[] = [];
    const overhead: number[] = [];
    const warm: number[] = [];
    let toolTurns = 0;
    for (let i = 0; i < turns; i++) {
      const e = exp[seen]!;
      const r = await timedTurn(s, `turn ${i}`, seen++, e);
      if (e.calls > 1) toolTurns++;
      turnMs.push(r.turnMs);
      overhead.push(r.turnMs - r.calls * modelDelayMs);
      warm.push(r.toModelMs);
    }
    await drain(s);
    const meters = await Promise.all(ACTORS.map((a) => s.meter(a)));
    const modelCalls = (await s.modelArrivals()).length - arrivals0;
    const ran = (await s.executorRuns()) - runs0;
    if (ran !== toolTurns) throw new Error(`bench: the executor ran ${ran} commands in ${toolTurns} tool turns`);
    const cold: number[] = [];
    const rejected: string[] = [];
    for (let i = 0; i < coldSamples; i++) {
      for (let attempt = 0; ; attempt++) {
        if (attempt >= COLD_ATTEMPTS) throw new Error(`bench: cold sample ${i}: ${COLD_ATTEMPTS} attempts, each woken by something other than the timed send: ${rejected.join("; ")}`);
        await timedTurn(s, `prime ${i}.${attempt}`, seen, exp[seen]!);
        seen++;
        await drain(s);
        const epoch0 = await s.epochOf("s1");
        // From here the meter shows only what happens after the eviction.
        await s.resetMeters();
        await s.evict("s1");
        // The timer starts at the send that wakes the evicted session, so activation is in it.
        const request = `cold-${i}-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
        const r = await timedTurn(s, `cold ${i}.${attempt}`, seen, exp[seen]!, request);
        seen++;
        const m = await s.meter("s1");
        const first = m.firstEvents[0];
        const why =
          m.activations !== 1 ? `${m.activations} activations after the eviction` :
          first !== `call:receive:${request}` ? `the first event of the activation was ${JSON.stringify(first)}, not the timed send` :
          undefined;
        const epoch1 = await s.epochOf("s1");
        if (!why && epoch1 <= epoch0) throw new Error(`bench: cold sample ${i}: s1 epoch ${epoch0} -> ${epoch1}, so the send did not wake an evicted actor`);
        if (why) {
          rejected.push(`attempt ${attempt}: ${why}`);
          continue;
        }
        cold.push(r.toModelMs);
        break;
      }
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
        adapterRows: sum((m) => m.adapterRows),
        timerCalls: sum((m) => m.timerCalls),
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
