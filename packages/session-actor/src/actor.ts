import type { Host } from "@hermesd/host";
import type { Executor } from "@hermesd/executor-protocol";
import { SessionActor, str, type ActorBehavior, type Clock, type JobFn, type RuntimeConfig } from "@hermesd/runtime";
import { checkLineage, compactSession, repairLineageRows } from "./lineage.ts";
import { LoopDriver, defaultLoopConfig, type LoopConfig } from "./loop.ts";
import { DEFAULT_MIGRATIONS, readPortRows, type MigrationSet } from "./migrate.ts";
import { applySessionSchema } from "./schema.ts";

export interface SessionActorDeps {
  clock: Clock;
  loop?: Partial<LoopConfig>;
  runtime?: Partial<RuntimeConfig>;
  jobs?: Record<string, JobFn>;
  migrations?: MigrationSet;
  /** Replace the executor client. The default is the sidecar `loop.executorTarget`. */
  executor?: (host: Host) => Executor;
}

/**
 * The session actor of the port: the runtime's `SessionActor` (wake
 * obligations, inbox, outbox, sweeper) with the upstream tables, the async
 * loop as its turn driver, and the calls that only this actor has: `stop`,
 * `op_event`, `resolve_unknown` and `compact`.
 */
export class PortSessionActor implements ActorBehavior {
  readonly #host: Host;
  readonly #inner: SessionActor;
  readonly driver: LoopDriver;
  readonly #deps: SessionActorDeps;
  readonly #loop: LoopConfig;
  readonly #set: MigrationSet;

  constructor(host: Host, deps: SessionActorDeps) {
    this.#host = host;
    this.#deps = deps;
    this.#loop = defaultLoopConfig(deps.loop);
    this.#set = deps.migrations ?? DEFAULT_MIGRATIONS;
    this.driver = new LoopDriver({
      clock: deps.clock,
      config: this.#loop,
      migrations: this.#set,
      ...(deps.executor ? { executor: deps.executor } : {}),
    });
    this.#inner = new SessionActor(host, {
      clock: deps.clock,
      driver: this.driver,
      config: { profileTarget: this.#loop.profileTarget, ...deps.runtime },
      ...(deps.jobs ? { jobs: deps.jobs } : {}),
    });
  }

  async activate(): Promise<void> {
    await this.#host.tx((sql) => applySessionSchema(sql));
    await this.#host.commit();
    await this.#inner.activate();
    // Adopt what the last owner left. Failures are not lost: the obligations and the sweeper bring the wake.
    void this.#adopt().catch(() => {});
  }

  alarm(): Promise<void> {
    return this.#inner.alarm();
  }

  async call(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "stop":
        return this.stop();
      case "op_event":
        // The executor reports that an operation changed. Read the status now.
        await this.driver.sweep(this.#host).catch(() => 0);
        return this.#inner.call("poke", { count: false });
      case "resolve_unknown":
        return this.resolveUnknown(((params ?? {}) as { note?: string }).note ?? "resolved by the user");
      case "compact":
        return { child: await compactSession(await this.#compactionDeps(), (params as { summary: string }).summary) };
      case "lineage_problems":
        return this.#host.tx((sql) => checkLineage(sql));
      default:
        return this.#inner.call(method, params);
    }
  }

  // ------------------------------------------------------------ calls only this actor has

  /**
   * The user sends /stop. The flag is written first, so a restart still sees
   * it. Then the model call is aborted (partial output is dropped) and the
   * turn is driven: it cancels the running operations and ends.
   */
  async stop(): Promise<{ stopped: boolean; turn?: string }> {
    const turn = await this.#host.tx((sql) => {
      const t = sql.exec("SELECT id FROM turns WHERE status = 'open' ORDER BY id LIMIT 1")[0];
      if (!t) return undefined;
      const id = str(t.id);
      sql.exec(
        "INSERT OR IGNORE INTO loop_turn (turn_id, interrupted, model_calls, schema_version, data) VALUES (?, 0, 0, ?, '{}')",
        id,
        this.#set.current,
      );
      sql.exec("UPDATE loop_turn SET interrupted = 1 WHERE turn_id = ?", id);
      return id;
    });
    await this.#host.commit();
    if (turn === undefined) return { stopped: false };
    this.driver.abortFetch(turn);
    await this.#inner.call("poke", { count: false });
    return { stopped: true, turn };
  }

  /**
   * The user resolves an admission that is `unknown`. Later inputs wait until
   * this happens (guide 6.3). The tool results are already in the transcript.
   */
  async resolveUnknown(note: string): Promise<{ resolved: number }> {
    const now = this.#deps.clock.now();
    const n = await this.#host.tx(
      (sql) =>
        sql.exec(
          "UPDATE session_admissions SET status = 'failed', result = ?, updated_at = ? WHERE status = 'unknown' RETURNING id",
          `resolved: ${note}`,
          now,
        ).length,
    );
    await this.#host.commit();
    await this.#inner.call("kick", {});
    return { resolved: n };
  }

  async #compactionDeps(): Promise<Parameters<typeof compactSession>[0]> {
    return {
      host: this.#host,
      clock: this.#deps.clock,
      migrations: this.#set,
      source: "teenytiny",
      model: this.#loop.model,
      systemPrompt: this.#loop.systemPrompt,
      systemPromptHash: await this.driver.promptHash(),
      profileTarget: this.#loop.profileTarget,
    };
  }

  // ------------------------------------------------------------ activation

  async #adopt(): Promise<void> {
    await this.#host.tx((sql) => repairLineageRows(sql, this.#set, this.#deps.clock.now()));
    await this.#host.commit();
    const busy = await this.#host.tx((sql) => {
      const open = sql.exec("SELECT 1 AS x FROM turns WHERE status = 'open' LIMIT 1").length > 0;
      const ops = readPortRows(sql, this.#set, "pending_op", "acked = 0 AND status != 'unknown'").length > 0;
      return open || ops;
    });
    if (!busy) return;
    // A new owner fences first, then reads the status of what is open, then goes on.
    await this.driver.fence(this.#host);
    await this.driver.sweep(this.#host);
    await this.#inner.call("poke", { count: true });
  }
}

export function createSessionActor(host: Host, deps: SessionActorDeps): PortSessionActor {
  return new PortSessionActor(host, deps);
}

