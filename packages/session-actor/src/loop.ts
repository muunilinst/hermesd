import type { Host, Sql } from "@hermesd/host";
import { deriveOpId, type Command, type CommandResult, type Executor, type OpStatus } from "@hermesd/executor-protocol";
import {
  num,
  str,
  type Clock,
  type OutboxWriter,
  type PendingRow,
  type TurnContext,
  type TurnDriver,
} from "@hermesd/runtime";
import {
  compressionConfig,
  estimateMessagesTokensRough,
  estimateRequestTokensRough,
  hygieneNeeded,
  planCompression,
  shouldCompress,
  thresholdTokens,
  withSummaryPrefix,
  type CompressionConfig,
} from "@hermesd/prompt";
import { rpcExecutor } from "./executor-rpc.ts";
import { VERDICT_PENDING, finishCompaction, writeWindowChild } from "./lineage.ts";
import {
  currentSessionId,
  ensureSession,
  insertMessage,
  insertPortRow,
  loadActiveMessages,
  recordUsage,
  toApiMessage,
  type NewMessage,
} from "./messages.ts";
import { DEFAULT_MIGRATIONS, readPortRow, readPortRows, type MigrationSet, type RowData } from "./migrate.ts";
import { chatRequest, estimateTokens, parseChatResponse, type ChatRequestBody, type ParsedResponse, type ToolCallWire, type Usage } from "./model/openai.ts";
import { answerResult, parseClarify, renderQuestions, type ClarifyQuestion } from "./tools/clarify.ts";
import { SUPPORTED_TOOLS, toolDefinitions, type ToolName } from "./tools/schemas.ts";
import { inputHash, parseTerminal, shellCommand, terminalResult, type BuildCommand } from "./tools/terminal.ts";
import { applyTodo, type TodoItem } from "./tools/todo.ts";

/**
 * The async loop (porting rule 1, guide 6.3) as a turn driver.
 *
 * One turn is: build the prompt, check the compression threshold, write
 * `pending_call` and its wake obligation and commit, then call the model
 * through an abortable fetch, persist the answer, and run the tool calls. The
 * position of the loop is always in rows. `start` and `resume` do the same
 * thing: read the rows and do the next step. On a wake the table of guide 6.3
 * decides what happens to each kind of pending row.
 */

export interface CompressionInfo {
  host: Host;
  estimatedTokens: number;
  threshold: number;
}

export interface LoopConfig {
  /** The tenant in op_id = H(tenant, session, intent). */
  tenant: string;
  /** The executor workspace. The incarnation is read from it. */
  workspace: string;
  model: string;
  systemPrompt: string;
  /** The URL for chat_completions. */
  modelUrl: string;
  apiKey?: string;
  /** The context size in tokens. Compression is due above 50% of it. */
  contextWindow: number;
  /** A model call that does not return is sent again at most this often, then the turn ends with an error. */
  maxModelRetries: number;
  tools: readonly ToolName[];
  buildCommand: BuildCommand;
  /** The sidecar that receives replies for the user, or null. */
  replyTarget: string | null;
  /** The sidecar of the profile actor, or null. */
  profileTarget: string | null;
  /** The sidecar name of the executor. */
  executorTarget: string;
  /**
   * The compression hook point (guide 2.3). The loop checks the 50% threshold
   * and calls this when it is exceeded. The hook may compact the session
   * (`compactSession`). This is the flat 50% form. When there is no hook, the
   * loop uses the built-in compressor (`@hermesd/prompt`), which sends the
   * summary call as a `pending_call` of its own.
   */
  compress?: (info: CompressionInfo) => Promise<void>;
  /** Knobs of the built-in compressor. The defaults are upstream's. */
  compression?: Partial<CompressionConfig>;
  /** The model for the summary call. The default is `model`. */
  summaryModel?: string;
}

export function defaultLoopConfig(partial: Partial<LoopConfig> = {}): LoopConfig {
  return {
    tenant: "tenant-1",
    workspace: "ws-1",
    model: "scripted-model",
    systemPrompt: "You are a helpful agent.",
    modelUrl: "http://model.test/v1/chat/completions",
    contextWindow: 128_000,
    maxModelRetries: 3,
    tools: SUPPORTED_TOOLS,
    buildCommand: shellCommand,
    replyTarget: null,
    profileTarget: null,
    executorTarget: "executor",
    ...partial,
  };
}

/**
 * The provider seam (guide 2.7). It is a structural type, so session-actor needs no
 * dependency on `@hermesd/providers`: its `ModelClient` fits. Without a client the
 * loop speaks chat_completions itself (`model/openai.ts`).
 *
 * `send` throws when the call gave no answer. An error with a numeric `status` of 429,
 * 408 or 5xx, a dropped stream (`name` is `StreamDroppedError`) and a transport error are
 * sent again: the loop waits for the wake obligation, the partial output is dropped, and
 * the stored bytes go out again with the same call id. `MalformedResponseError` and any
 * other status end the turn. An abort is an interrupt.
 */
export interface LoopModelClient {
  buildBody(input: { model?: string; messages: unknown[]; tools: unknown[] }): string;
  send(
    body: string,
    ctx: { callId: string; fetch: (req: Request, signal?: AbortSignal) => Promise<Response>; signal?: AbortSignal; apiKey?: string },
  ): Promise<{ response: ParsedResponse; raw: string }>;
}

export interface LoopDeps {
  clock: Clock;
  config: LoopConfig;
  migrations?: MigrationSet;
  /** The model client of the API mode. The default is chat_completions at `config.modelUrl`. */
  modelClient?: LoopModelClient;
  /** Replace the executor client. The default is the sidecar `config.executorTarget`. */
  executor?: (host: Host) => Executor;
}

/** The step lost a race with an interrupt or another writer. Read the rows again. */
class StepRaced extends Error {
  constructor() {
    super("step raced");
    this.name = "StepRaced";
  }
}

/** The executor refused our epoch: a newer owner exists. This activation must stop. */
export class SupersededError extends Error {
  readonly code = "superseded";
  constructor() {
    super("a newer owner has fenced this session");
    this.name = "SupersededError";
  }
}

interface CallRow {
  callId: string;
  seq: number;
  request: string;
  pendingId: string | undefined;
  attempts: number;
  data: RowData;
}

interface OpRow {
  opId: string;
  uid: string;
  toolCallId: string;
  toolName: string;
  incarnation: number;
  inputHash: string;
  command: Command;
  pendingId: string | undefined;
}

interface QuestionRow {
  uid: string;
  turnId: string;
  toolCallId: string;
  questions: ClarifyQuestion[];
}

interface Snapshot {
  sessionId: string;
  messages: NewMessage[];
  todos: TodoItem[];
  modelCalls: number;
  interrupted: boolean;
  /** False when the turn has ended (this driver may be late). */
  open: boolean;
  call: CallRow | undefined;
  ops: OpRow[];
  question: QuestionRow | undefined;
  /** The summary calls that this turn has made. */
  compressions: number;
  /** The child session of a compaction that no measurement has judged yet. */
  verdictPending: string | undefined;
  /** Upstream `compression_ineffective_count` of the current session. */
  ineffective: number;
}

type OpOutcome =
  | { k: "wait" }
  | { k: "terminal"; status: "done" | "failed" | "cancelled" | "unknown"; result?: CommandResult | undefined; reason?: string | undefined };

interface OpPlan {
  opId: string;
  uid: string;
  toolCallId: string;
  toolName: string;
  incarnation: number;
  inputHash: string;
  command: Command;
}

interface Plan {
  messages: NewMessage[];
  todoWrite: TodoItem[] | undefined;
  question: { uid: string; toolCallId: string; questions: ClarifyQuestion[] } | undefined;
  ops: OpPlan[];
  modelCall: { callId: string; seq: number; request: string; data: RowData } | undefined;
  finish: { status: "done" | "failed" | "unknown"; text: string } | undefined;
  /** Writes that join the commit of this step (the anti-thrash verdict). */
  postWrites: Array<(sql: Sql) => void>;
  /** Send the finish text to the user. False when the user already got a message (the clarify question). */
  finishReply: boolean;
}

/** What the caller of `transition` wants written together with the next step. */
interface Transition {
  /** Pending rows to settle. */
  settle?: Array<{ id: string; result: unknown }>;
  newMessages: NewMessage[];
  usage?: { usage: Usage } | undefined;
  /** Must hold, or the step is raced. Runs first, inside the transaction. */
  guard?: (sql: Sql) => boolean;
  /** Extra writes of the caller. */
  after?: (sql: Sql, now: number) => void;
  /** Ops that end in this transition: their rows are updated. */
  opUpdates?: Array<{ opId: string; status: string; discard: boolean; result: unknown }>;
  /** Set when the compression hook ran and the snapshot must be read again. */
  recompressed?: boolean;
  /** The first step of a turn: the gateway hygiene check applies (upstream `run_turn_hygiene.py`). */
  hygiene?: boolean;
}

const MAX_LOOP = 200;
/** A safety stop of the port: one turn makes at most this many summary calls. */
const MAX_COMPRESSIONS_PER_TURN = 3;

export class LoopDriver implements TurnDriver {
  readonly #deps: LoopDeps;
  readonly #cfg: LoopConfig;
  readonly #set: MigrationSet;
  readonly #fetches = new Map<string, AbortController>();
  #fenced = false;
  #promptHash: string | undefined;

  constructor(deps: LoopDeps) {
    this.#deps = deps;
    this.#cfg = deps.config;
    this.#set = deps.migrations ?? DEFAULT_MIGRATIONS;
  }

  get migrations(): MigrationSet {
    return this.#set;
  }

  // ------------------------------------------------------------ driver entry points

  async start(ctx: TurnContext): Promise<void> {
    await this.#guarded(async () => {
      if (!(await this.#begin(ctx))) return;
      await this.#run(ctx);
    });
  }

  async resume(ctx: TurnContext, _pending: PendingRow[]): Promise<void> {
    await this.#guarded(() => this.#run(ctx));
  }

  /** Abort the model call of a turn, if one is in flight in this activation. */
  abortFetch(turnId: string): boolean {
    const ac = this.#fetches.get(turnId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  /** The executor owner fence for this activation. Call it before the first executor call. */
  async fence(host: Host): Promise<void> {
    if (this.#fenced) return;
    await this.#executor(host).fence(host.id(), host.epoch());
    this.#fenced = true;
  }

  async #guarded(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof SupersededError) return; // another owner has the session; do nothing
      if (e instanceof StepRaced) return; // the turn ended or was interrupted meanwhile; the next drive reads the rows
      throw e;
    }
  }

  #executor(host: Host): Executor {
    return this.#deps.executor ? this.#deps.executor(host) : rpcExecutor(host.sidecar(this.#cfg.executorTarget));
  }

  /** The hash of the system prompt, as stored in `system_prompts`. */
  async promptHash(): Promise<string> {
    if (!this.#promptHash) {
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.#cfg.systemPrompt));
      this.#promptHash = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return this.#promptHash;
  }

  // ------------------------------------------------------------ reading the position

  #snapshot(sql: Sql, ctx: TurnContext): Snapshot {
    const sessionId = currentSessionId(sql, ctx.host.id());
    const turn = readPortRow(sql, this.#set, "loop_turn", "turn_id = ?", ctx.turnId);
    const pendingRows = sql.exec("SELECT id, kind, payload, attempts FROM pending_rows WHERE turn_id = ? AND status = 'pending'", ctx.turnId);
    const pendingFor = (kind: string, key: "callId" | "opId", value: string): { id: string; attempts: number } | undefined => {
      for (const r of pendingRows) {
        if (str(r.kind) !== kind) continue;
        if ((JSON.parse(str(r.payload)) as Record<string, string>)[key] === value) return { id: str(r.id), attempts: num(r.attempts) };
      }
      return undefined;
    };
    const callRow = readPortRow(sql, this.#set, "pending_call", "turn_id = ? AND status = 'pending'", ctx.turnId);
    const ops = readPortRows(sql, this.#set, "pending_op", "turn_id = ? AND status = 'pending' AND discard = 0 ORDER BY created_at, rowid", ctx.turnId).map(
      (o): OpRow => ({
        opId: str(o.row.op_id),
        uid: str(o.row.tool_call_uid),
        toolCallId: str(o.row.tool_call_id),
        toolName: str(o.row.tool_name),
        incarnation: num(o.row.incarnation),
        inputHash: str(o.row.input_hash),
        command: o.data.command as Command,
        pendingId: pendingFor("tool_op", "opId", str(o.row.op_id))?.id,
      }),
    );
    const q = readPortRow(sql, this.#set, "clarify_question", "status = 'open'");
    const todos = readPortRows(sql, this.#set, "todo_item", "1 = 1 ORDER BY position").map((t) => t.data as unknown as TodoItem);
    let call: CallRow | undefined;
    if (callRow) {
      const p = pendingFor("model_call", "callId", str(callRow.row.call_id));
      call = { callId: str(callRow.row.call_id), seq: num(callRow.row.seq), request: str(callRow.row.request), pendingId: p?.id, attempts: p?.attempts ?? 0, data: callRow.data };
    }
    const verdict = sql.exec("SELECT value FROM sa_meta WHERE key = ?", VERDICT_PENDING)[0];
    const sess = sql.exec("SELECT compression_ineffective_count AS c FROM sessions WHERE id = ?", sessionId)[0];
    const compressions = sql.exec("SELECT call_id FROM pending_call WHERE turn_id = ?", ctx.turnId).filter((r) => str(r.call_id).startsWith(`${ctx.turnId}:k`)).length;
    return {
      sessionId,
      compressions,
      verdictPending: verdict ? str(verdict.value) : undefined,
      ineffective: sess && sess.c !== null && sess.c !== undefined ? num(sess.c) : 0,
      messages: loadActiveMessages(sql, sessionId),
      todos,
      modelCalls: turn ? num(turn.row.model_calls) : 0,
      interrupted: turn ? num(turn.row.interrupted) === 1 : false,
      open: sql.exec("SELECT 1 AS x FROM turns WHERE id = ? AND status = 'open'", ctx.turnId).length > 0,
      call,
      ops,
      question: q
        ? { uid: str(q.row.tool_call_uid), turnId: str(q.row.turn_id), toolCallId: String(q.data.tool_call_id), questions: q.data.questions as ClarifyQuestion[] }
        : undefined,
    };
  }

  // ------------------------------------------------------------ the start of a turn

  /** Write the first step of a turn. Returns false if the turn ended here. */
  async #begin(ctx: TurnContext): Promise<boolean> {
    const snap = await ctx.host.tx((sql) => this.#snapshot(sql, ctx));
    if (snap.interrupted) {
      await this.#finishEmpty(ctx, "done", "interrupted");
      return false;
    }
    if (snap.question) {
      // The input answers the question. It is the result of the clarify tool call.
      const q = snap.question;
      const msg: NewMessage = {
        role: "tool",
        content: answerResult(q.questions, ctx.input),
        toolCallId: q.toolCallId,
        toolCallUid: q.uid,
        toolName: "clarify",
        messageUid: `${q.uid}:r`,
      };
      await this.#transition(ctx, snap, {
        newMessages: [msg],
        hygiene: true,
        after: (sql) => {
          sql.exec("UPDATE clarify_question SET status = 'answered' WHERE tool_call_uid = ?", q.uid);
        },
      });
      return true;
    }
    const user: NewMessage = { role: "user", content: ctx.input, messageUid: `adm-${ctx.admissionId}` };
    await this.#transition(ctx, snap, { newMessages: [user], hygiene: true });
    return true;
  }

  async #finishEmpty(ctx: TurnContext, status: "done" | "failed", text: string): Promise<void> {
    await ctx.step({
      write: (sql, outbox) => {
        if (!turnIsOpen(sql, ctx.turnId)) throw new StepRaced();
        this.#reply(outbox, ctx.turnId, status === "done" ? text : `error: ${text}`);
      },
      finish: { status, text },
    });
  }

  // ------------------------------------------------------------ the loop

  async #run(ctx: TurnContext): Promise<void> {
    for (let i = 0; i < MAX_LOOP; i++) {
      const snap = await ctx.host.tx((sql) => this.#snapshot(sql, ctx));
      if (!snap.open) return;
      if (snap.interrupted) return this.#interrupt(ctx, snap);
      if (snap.call) {
        const r = await this.#sendCall(ctx, snap, snap.call);
        if (r === "again") continue;
        return;
      }
      if (snap.ops.length > 0) {
        const r = await this.#driveOps(ctx, snap);
        if (r === "again") continue;
        return;
      }
      // Nothing is pending. The transcript decides the next step.
      const wrote = await this.#transition(ctx, snap, { newMessages: [] });
      if (!wrote) return;
    }
    await ctx.finish("failed", "the loop did not settle");
  }

  // ------------------------------------------------------------ the model call

  async #sendCall(ctx: TurnContext, snap: Snapshot, row: CallRow): Promise<"again" | "wait"> {
    const compression = row.data.purpose === "compression";
    if (row.attempts > this.#cfg.maxModelRetries) {
      const why = `the model call ${row.callId} did not return after ${row.attempts - 1} retries`;
      if (compression) return this.#finishCompression(ctx, snap, row, { fallbackReason: why });
      await this.#failCall(ctx, row, why);
      return "wait";
    }
    const ac = new AbortController();
    this.#fetches.set(ctx.turnId, ac);
    let parsed: ParsedResponse | string;
    let text: string;
    if (this.#deps.modelClient) {
      const r = await this.#callClient(ctx, row, ac, this.#deps.modelClient);
      if ("end" in r) return r.end;
      if ("fail" in r) {
        if (compression) return this.#finishCompression(ctx, snap, row, { fallbackReason: r.fail });
        await this.#failCall(ctx, row, r.fail);
        return "wait";
      }
      parsed = r.parsed;
      text = r.text;
    } else {
      let res: Response;
      try {
        res = await ctx.host.fetch(chatRequest(this.#cfg.modelUrl, row.request, row.callId, this.#cfg.apiKey), ac.signal);
        text = await res.text();
      } catch {
        // An abort is an interrupt. Anything else may be sent again: the obligation brings the wake.
        return ac.signal.aborted ? "again" : "wait";
      } finally {
        if (this.#fetches.get(ctx.turnId) === ac) this.#fetches.delete(ctx.turnId);
      }
      if (ac.signal.aborted) return "again"; // partial output is dropped
      if (res.status === 429 || res.status === 408 || res.status >= 500) return "wait";
      if (!res.ok) {
        const why = `the model returned HTTP ${res.status}`;
        if (compression) return this.#finishCompression(ctx, snap, row, { fallbackReason: why });
        await this.#failCall(ctx, row, why);
        return "wait";
      }
      try {
        parsed = parseChatResponse(JSON.parse(text) as unknown);
      } catch {
        parsed = "the model answer is not JSON";
      }
    }
    if (typeof parsed === "string") {
      if (compression) return this.#finishCompression(ctx, snap, row, { fallbackReason: parsed });
      await this.#failCall(ctx, row, parsed);
      return "wait";
    }
    if (compression) {
      const body = (parsed.content ?? "").trim();
      const digest = await sha256(text);
      if (body === "") return this.#finishCompression(ctx, snap, row, { fallbackReason: "the summary model returned no text" }, parsed.usage, digest);
      return this.#finishCompression(ctx, snap, row, { text: withSummaryPrefix(body) }, parsed.usage, digest);
    }
    const uids = parsed.toolCalls.map((_c, i) => `${row.callId}#${i}`);
    const assistant: NewMessage = {
      role: "assistant",
      content: parsed.content,
      messageUid: `${row.callId}:a`,
      ...(parsed.toolCalls.length > 0 ? { toolCalls: parsed.toolCalls, toolCallUids: uids } : {}),
      ...(parsed.finishReason ? { finishReason: parsed.finishReason } : {}),
      tokenCount: parsed.usage.completionTokens,
    };
    const digest = await sha256(text);
    try {
      await this.#transition(ctx, snap, {
        settle: row.pendingId ? [{ id: row.pendingId, result: "response" }] : [],
        newMessages: [assistant],
        usage: { usage: parsed.usage },
        guard: (sql) => num(sql.exec("SELECT COUNT(*) AS n FROM pending_call WHERE call_id = ? AND status = 'pending'", row.callId)[0]!.n) === 1,
        after: (sql, now) => {
          sql.exec("UPDATE pending_call SET status = 'done', response_digest = ?, updated_at = ? WHERE call_id = ?", digest, now, row.callId);
        },
      });
    } catch (e) {
      if (e instanceof StepRaced) return "again";
      return this.#persistenceFailed(ctx, row, e);
    }
    return "again";
  }

  /**
   * The end of a summary call. One commit settles the call, writes the child
   * session and makes it the current session. A second commit (the D7 pattern)
   * turns the parent rows inactive. The guard on `pending_call` means a summary
   * is used once: a second wake finds the call settled and does nothing.
   * If the model cannot give a summary, the static fallback is used, as
   * upstream does when the summary call fails, and the turn goes on.
   */
  async #finishCompression(
    ctx: TurnContext,
    _snap: Snapshot,
    row: CallRow,
    summary: { text: string } | { fallbackReason: string },
    usage?: Usage,
    digest?: string,
  ): Promise<"again"> {
    const now = this.#deps.clock.now();
    const promptHash = await this.promptHash();
    const d = row.data;
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    let made = false;
    try {
      await ctx.step({
        settle: row.pendingId ? [{ id: row.pendingId, result: "response" }] : [],
        write: (sql, outbox) => {
          if (!turnIsOpen(sql, ctx.turnId)) throw new StepRaced();
          if (num(sql.exec("SELECT COUNT(*) AS n FROM pending_call WHERE call_id = ? AND status = 'pending'", row.callId)[0]!.n) !== 1) throw new StepRaced();
          const turn = sql.exec("SELECT interrupted FROM loop_turn WHERE turn_id = ?", ctx.turnId)[0];
          if (turn && num(turn.interrupted) === 1) throw new StepRaced();
          const r = writeWindowChild(
            sql,
            { migrations: this.#set, source: "teenytiny", model: this.#cfg.model, systemPrompt: this.#cfg.systemPrompt, systemPromptHash: promptHash, profileTarget: this.#cfg.profileTarget, fallbackId: ctx.host.id() },
            outbox,
            {
              headUids: strs(d.head_uids),
              middleUids: strs(d.middle_uids),
              summary,
              tokensBefore: Number(d.tokens_before ?? 0),
              reason: String(d.reason ?? "threshold"),
              turnId: ctx.turnId,
            },
            now,
          );
          made = r !== undefined;
          if (usage) recordUsage(sql, currentSessionId(sql, ctx.host.id()), String(d.summary_model ?? this.#cfg.model), usage, now);
          const outcome = r ? { child_id: r.childId, tokens_after: r.tokensAfter, fallback: r.fallback } : { skipped: "the rows changed" };
          sql.exec(
            "UPDATE pending_call SET status = 'done', response_digest = ?, updated_at = ?, data = ? WHERE call_id = ?",
            digest ?? null,
            now,
            JSON.stringify({ ...d, outcome }),
            row.callId,
          );
        },
      });
    } catch (e) {
      if (e instanceof StepRaced) return "again";
      throw e;
    }
    if (made) await finishCompaction({ host: ctx.host, clock: this.#deps.clock, migrations: this.#set });
    return "again";
  }

  /** One try through the provider seam. It never writes: the caller acts on the outcome. */
  async #callClient(
    ctx: TurnContext,
    row: CallRow,
    ac: AbortController,
    client: LoopModelClient,
  ): Promise<{ parsed: ParsedResponse; text: string } | { end: "again" | "wait" } | { fail: string }> {
    try {
      const sent = await client.send(row.request, {
        callId: row.callId,
        fetch: (req, signal) => ctx.host.fetch(req, signal),
        signal: ac.signal,
        ...(this.#cfg.apiKey ? { apiKey: this.#cfg.apiKey } : {}),
      });
      if (ac.signal.aborted) return { end: "again" };
      return { parsed: sent.response, text: sent.raw };
    } catch (e) {
      if (ac.signal.aborted) return { end: "again" }; // partial output is dropped
      const status = (e as { status?: unknown } | null)?.status;
      if (typeof status === "number" && !(status === 429 || status === 408 || status >= 500)) return { fail: `the model returned HTTP ${status}` };
      if (e instanceof Error && e.name === "MalformedResponseError") return { fail: e.message };
      // A transport error or a dropped stream: the obligation brings the wake, and the same bytes go out again.
      return { end: "wait" };
    } finally {
      if (this.#fetches.get(ctx.turnId) === ac) this.#fetches.delete(ctx.turnId);
    }
  }

  /** The tool-call turn could not be written. The turn ends, and no tool runs (guide 2.3). */
  async #persistenceFailed(ctx: TurnContext, row: CallRow, cause: unknown): Promise<"wait"> {
    if (cause instanceof Error && cause.name === "StaleEpochError") throw cause; // we are not the owner: do nothing
    const detail = cause instanceof Error ? cause.message : String(cause);
    await this.#failCall(ctx, row, `session_persistence_failed: ${detail}`);
    return "wait";
  }

  async #failCall(ctx: TurnContext, row: CallRow, error: string): Promise<void> {
    const now = this.#deps.clock.now();
    await ctx.step({
      settle: row.pendingId ? [{ id: row.pendingId, result: "failed" }] : [],
      write: (sql, outbox) => {
        if (!turnIsOpen(sql, ctx.turnId)) throw new StepRaced();
        sql.exec("UPDATE pending_call SET status = 'failed', error = ?, updated_at = ? WHERE call_id = ? AND status = 'pending'", error, now, row.callId);
        this.#reply(outbox, ctx.turnId, `error: ${error}`);
      },
      finish: { status: "failed", text: error },
    });
  }

  // ------------------------------------------------------------ planning the next step

  /**
   * Write the next step. The rows of the answer or the results, the inline
   * tools, the new pending rows and the end of the turn are one commit.
   * Returns false if there was nothing to write.
   */
  async #transition(ctx: TurnContext, snap: Snapshot, t: Transition): Promise<boolean> {
    const plan = await this.#plan(ctx, snap, t);
    if (plan.modelCall && !this.#cfg.compress) this.#compressionDue(ctx, snap, t, plan);
    if (plan.modelCall && !t.recompressed && this.#cfg.compress) {
      const body = JSON.parse(plan.modelCall.request) as ChatRequestBody;
      const tokens = estimateTokens(body);
      const threshold = Math.floor(this.#cfg.contextWindow * 0.5);
      if (tokens > threshold) {
        await this.#cfg.compress({ host: ctx.host, estimatedTokens: tokens, threshold });
        const fresh = await ctx.host.tx((sql) => this.#snapshot(sql, ctx));
        return this.#transition(ctx, fresh, { ...t, recompressed: true });
      }
    }
    const empty = plan.messages.length === 0 && !plan.todoWrite && !plan.question && plan.ops.length === 0 && !plan.modelCall && !plan.finish && !(t.settle?.length);
    if (empty && !t.after && !t.opUpdates?.length) return false;
    const now = this.#deps.clock.now();
    const pend: Array<{ kind: string; payload: unknown }> = [];
    for (const op of plan.ops) pend.push({ kind: "tool_op", payload: { opId: op.opId, uid: op.uid } });
    if (plan.modelCall) pend.push({ kind: "model_call", payload: { callId: plan.modelCall.callId } });
    const promptHash = await this.promptHash();
    const write = (sql: Sql, outbox: OutboxWriter): void => {
      if (!turnIsOpen(sql, ctx.turnId)) throw new StepRaced();
      if (t.guard && !t.guard(sql)) throw new StepRaced();
      const turn = sql.exec("SELECT interrupted FROM loop_turn WHERE turn_id = ?", ctx.turnId)[0];
      if (turn && num(turn.interrupted) === 1 && !plan.finish) throw new StepRaced();
      if (!turn) insertPortRow(sql, this.#set, "loop_turn", { turn_id: ctx.turnId, interrupted: 0, model_calls: 0 }, {});
      ensureSession(sql, { id: snap.sessionId, source: "teenytiny", model: this.#cfg.model, systemPrompt: this.#cfg.systemPrompt, systemPromptHash: promptHash }, now);
      for (const m of plan.messages) {
        const id = insertMessage(sql, snap.sessionId, m, now);
        if (id !== undefined && m.content && this.#cfg.profileTarget) {
          outbox.enqueue(this.#cfg.profileTarget, "index", { seq: id, role: m.role, text: m.content });
        }
      }
      if (t.usage) recordUsage(sql, snap.sessionId, this.#cfg.model, t.usage.usage, now);
      if (plan.todoWrite) {
        sql.exec("DELETE FROM todo_item");
        plan.todoWrite.forEach((item, i) => insertPortRow(sql, this.#set, "todo_item", { id: item.id, position: i }, { ...item }));
      }
      if (plan.question) {
        insertPortRow(
          sql,
          this.#set,
          "clarify_question",
          { tool_call_uid: plan.question.uid, turn_id: ctx.turnId, status: "open", created_at: now },
          { tool_call_id: plan.question.toolCallId, questions: plan.question.questions },
        );
        this.#reply(outbox, ctx.turnId, renderQuestions(plan.question.questions));
      }
      for (const u of t.opUpdates ?? []) {
        sql.exec("UPDATE pending_op SET status = ?, discard = ?, updated_at = ? WHERE op_id = ?", u.status, u.discard ? 1 : 0, now, u.opId);
        const o = readPortRow(sql, this.#set, "pending_op", "op_id = ?", u.opId);
        if (o) sql.exec("UPDATE pending_op SET data = ? WHERE op_id = ?", JSON.stringify({ ...o.data, result: u.result }), u.opId);
      }
      for (const op of plan.ops) {
        insertPortRow(
          sql,
          this.#set,
          "pending_op",
          {
            op_id: op.opId,
            turn_id: ctx.turnId,
            tool_call_uid: op.uid,
            tool_call_id: op.toolCallId,
            tool_name: op.toolName,
            incarnation: op.incarnation,
            input_hash: op.inputHash,
            status: "pending",
            created_at: now,
            updated_at: now,
          },
          { command: op.command },
        );
      }
      if (plan.modelCall) {
        const c = plan.modelCall;
        insertPortRow(
          sql,
          this.#set,
          "pending_call",
          { call_id: c.callId, turn_id: ctx.turnId, seq: c.seq, status: "pending", request: c.request, created_at: now, updated_at: now },
          c.data,
        );
        sql.exec("UPDATE loop_turn SET model_calls = ? WHERE turn_id = ?", c.seq, ctx.turnId);
      }
      for (const w of plan.postWrites) w(sql);
      t.after?.(sql, now);
      if (plan.finish) {
        if (plan.finishReply) this.#reply(outbox, ctx.turnId, plan.finish.status === "done" ? plan.finish.text : `error: ${plan.finish.text}`);
        this.#sessionUpsert(sql, outbox, snap.sessionId, plan.finish.status, now);
      }
    };
    await ctx.step({
      settle: t.settle ?? [],
      write,
      pend,
      ...(plan.finish ? { finish: plan.finish } : {}),
    });
    return true;
  }

  async #plan(ctx: TurnContext, snap: Snapshot, t: Transition): Promise<Plan> {
    const plan: Plan = { messages: [...t.newMessages], todoWrite: undefined, question: undefined, ops: [], modelCall: undefined, finish: undefined, postWrites: [], finishReply: true };
    const all = [...snap.messages, ...t.newMessages];
    let todos = snap.todos;
    for (let guard = 0; guard < 10; guard++) {
      const a = analyze(all);
      if (a.kind === "finish") {
        plan.finish = { status: "done", text: a.text };
        return plan;
      }
      if (a.kind === "model_call") {
        plan.modelCall = await this.#buildCall(ctx, snap, all);
        return plan;
      }
      // Tools. A batch with an interactive tool runs one call at a time, in order.
      const sequential = a.calls.some((c) => c.function.name === "clarify");
      let blocked = false;
      const opsFor: Array<{ call: ToolCallWire; uid: string; cmd: Command }> = [];
      for (const { call, uid } of a.unresolved) {
        const done = (content: string): void => {
          const msg: NewMessage = { role: "tool", content, toolCallId: call.id, toolCallUid: uid, toolName: call.function.name, messageUid: `${uid}:r` };
          plan.messages.push(msg);
          all.push(msg);
        };
        const name = call.function.name;
        let args: unknown;
        try {
          args = call.function.arguments === "" ? {} : (JSON.parse(call.function.arguments) as unknown);
        } catch {
          done(JSON.stringify({ error: `the arguments of ${name} are not valid JSON` }));
          continue;
        }
        if (!(this.#cfg.tools as readonly string[]).includes(name)) {
          done(JSON.stringify({ error: `Unknown tool '${name}'` }));
          continue;
        }
        if (name === "todo_list") {
          const out = applyTodo(todos, args);
          if (out.changed) {
            todos = out.items;
            plan.todoWrite = out.items;
          }
          done(out.result);
          continue;
        }
        if (name === "session_search") {
          done(await this.#sessionSearch(ctx.host, args));
          continue;
        }
        if (name === "clarify") {
          const qs = parseClarify(args);
          if (typeof qs === "string") {
            done(JSON.stringify({ error: qs }));
            continue;
          }
          plan.question = { uid, toolCallId: call.id, questions: qs };
          blocked = true;
          break;
        }
        // terminal
        const targs = parseTerminal(args);
        if (typeof targs === "string") {
          done(JSON.stringify({ error: targs }));
          continue;
        }
        opsFor.push({ call, uid, cmd: this.#cfg.buildCommand(targs) });
        if (sequential) {
          blocked = true;
          break;
        }
      }
      if (plan.question) {
        // The turn ends and waits for the answer. The question is the reply; the finish text is for the admission only.
        plan.finish = { status: "done", text: "waiting for the answer to a clarify question" };
        plan.finishReply = false;
        return plan;
      }
      if (opsFor.length > 0) {
        await this.#fenceOnce(ctx);
        const ex = this.#executor(ctx.host);
        const { incarnation } = await ex.describe(this.#cfg.workspace);
        for (const o of opsFor) {
          plan.ops.push({
            opId: await deriveOpId(this.#cfg.tenant, ctx.host.id(), o.uid),
            uid: o.uid,
            toolCallId: o.call.id,
            toolName: o.call.function.name,
            incarnation,
            inputHash: await inputHash(o.cmd),
            command: o.cmd,
          });
        }
        return plan;
      }
      if (blocked) return plan;
      // All calls were answered inline: look again.
    }
    throw new Error("planning did not settle");
  }

  /**
   * The `session_search` tool. It asks the profile actor, which holds the
   * search index of all sessions (guide 6.4). It only reads, so a replay of
   * the planning step is safe. Only the discovery shape (`query`) is built.
   * The result is the port's own JSON, not upstream's hydrated sessions.
   */
  async #sessionSearch(host: Host, args: unknown): Promise<string> {
    const target = this.#cfg.profileTarget;
    const a = (args ?? {}) as { query?: unknown; limit?: unknown };
    if (!target) return JSON.stringify({ error: "session_search needs the profile actor" });
    if (typeof a.query !== "string" || a.query.trim() === "") return JSON.stringify({ error: "session_search needs a query" });
    const limit = typeof a.limit === "number" && a.limit > 0 ? Math.min(Math.floor(a.limit), 10) : 3;
    const hits = (await host.sidecar(target).call("session_search", { query: a.query, limit })) as unknown[];
    return JSON.stringify({ success: true, query: a.query, count: hits.length, results: hits });
  }

  async #fenceOnce(ctx: TurnContext): Promise<void> {
    await this.fence(ctx.host);
  }

  /**
   * The compression check before a model call (upstream `should_compress`,
   * the gateway hygiene check, and the anti-thrash verdict). If compression is
   * due, the planned model call is replaced by the summary call, which is a
   * `pending_call` of its own with its own wake obligation (porting rule 1).
   * The model call itself is planned again after the compaction.
   */
  #compressionDue(ctx: TurnContext, snap: Snapshot, t: Transition, plan: Plan): void {
    if (!plan.modelCall) return;
    const cfg = compressionConfig(this.#cfg.compression);
    const window = this.#cfg.contextWindow;
    const all = [...snap.messages, ...plan.messages];
    const tokens = estimateRequestTokensRough(all, { systemPrompt: this.#cfg.systemPrompt, tools: toolDefinitions(this.#cfg.tools) });
    const threshold = thresholdTokens(window, cfg);
    // The verdict on the last compaction is judged on this measurement.
    let strikes = snap.ineffective;
    if (snap.verdictPending !== undefined) {
      strikes = tokens >= threshold ? strikes + 1 : 0;
      plan.postWrites.push((sql) => {
        sql.exec("UPDATE sessions SET compression_ineffective_count = ? WHERE id = ?", strikes, snap.sessionId);
        sql.exec("DELETE FROM sa_meta WHERE key = ?", VERDICT_PENDING);
      });
    }
    const hygiene = t.hygiene === true && hygieneNeeded(estimateMessagesTokensRough(snap.messages), snap.messages.length, window, cfg);
    const due = hygiene || (shouldCompress(tokens, window, cfg) && strikes < 2);
    if (!due || snap.compressions >= MAX_COMPRESSIONS_PER_TURN) return;
    const today = new Date(this.#deps.clock.now()).toISOString().slice(0, 10);
    const planned = planCompression(all, { contextLength: window, today, config: cfg });
    if (!planned) return;
    const model = this.#cfg.summaryModel ?? this.#cfg.model;
    const body: ChatRequestBody = { model, messages: [{ role: "user", content: planned.prompt }], tools: [] };
    const uids = (from: number, to: number): string[] => all.slice(from, to).map((m) => m.messageUid);
    plan.modelCall = {
      callId: `${ctx.turnId}:k${snap.compressions + 1}`,
      // The summary call does not count as a model call of the turn.
      seq: snap.modelCalls,
      request: this.#deps.modelClient ? this.#deps.modelClient.buildBody(body) : JSON.stringify(body),
      data: {
        purpose: "compression",
        reason: hygiene ? "hygiene" : "threshold",
        summary_model: model,
        head_uids: uids(0, planned.window.start),
        middle_uids: uids(planned.window.start, planned.window.end),
        tokens_before: tokens,
        threshold,
      },
    };
  }

  async #buildCall(ctx: TurnContext, snap: Snapshot, all: NewMessage[]): Promise<NonNullable<Plan["modelCall"]>> {
    const body: ChatRequestBody = {
      model: this.#cfg.model,
      messages: [{ role: "system", content: this.#cfg.systemPrompt }, ...all.map(toApiMessage)],
      tools: toolDefinitions(this.#cfg.tools),
    };
    const request = this.#deps.modelClient ? this.#deps.modelClient.buildBody(body) : JSON.stringify(body);
    const tokens = this.#deps.modelClient ? Math.ceil(request.length / 4) : estimateTokens(body);
    const threshold = this.#cfg.compress ? Math.floor(this.#cfg.contextWindow * 0.5) : thresholdTokens(this.#cfg.contextWindow, compressionConfig(this.#cfg.compression));
    const seq = snap.modelCalls + 1;
    return {
      callId: `${ctx.turnId}:c${seq}`,
      seq,
      request,
      data: { estimated_tokens: tokens, compression_due: tokens > threshold },
    };
  }

  // ------------------------------------------------------------ tool operations

  /** The wake table for `pending_op` (guide 6.3). */
  async #driveOps(ctx: TurnContext, snap: Snapshot): Promise<"again" | "wait"> {
    await this.#fenceOnce(ctx);
    const outcomes: Array<{ op: OpRow; out: Extract<OpOutcome, { k: "terminal" }> }> = [];
    for (const op of snap.ops) {
      const out = await this.#driveOp(ctx, op);
      if (out.k === "terminal") outcomes.push({ op, out });
    }
    if (outcomes.length === 0) return "wait";
    const unknown = outcomes.find((o) => o.out.status === "unknown");
    if (unknown) {
      await this.#abandon(ctx, snap, {
        finish: { status: "unknown", text: `the outcome of the command for tool call ${unknown.op.uid} is unknown` },
        recorded: outcomes,
        ask: true,
      });
      return "wait";
    }
    // Results are recorded in the order of the tool calls, as upstream does: only the finished prefix.
    const ready: typeof outcomes = [];
    for (const op of snap.ops) {
      const o = outcomes.find((x) => x.op.opId === op.opId);
      if (!o) break;
      ready.push(o);
    }
    if (ready.length === 0) return "wait";
    await this.#transition(ctx, snap, {
      settle: ready.flatMap(({ op }) => (op.pendingId ? [{ id: op.pendingId, result: "recorded" }] : [])),
      newMessages: ready.map(({ op, out }) => toolMessage(op, out)),
      opUpdates: ready.map(({ op, out }) => ({ opId: op.opId, status: out.status, discard: false, result: out.result ?? null })),
    });
    await this.#ackAll(ctx.host, ready.map((o) => o.op.opId));
    return "again";
  }

  async #driveOp(ctx: TurnContext, op: OpRow): Promise<OpOutcome> {
    const ex = this.#executor(ctx.host);
    const epoch = ctx.host.epoch();
    const opId = op.opId as Parameters<Executor["start"]>[0];
    let m = mapStatus(await ex.status(opId));
    if (m === "missing") {
      // The executor has no usable record. Prepare again with the stored incarnation; the executor deduplicates.
      const p = await ex.prepare({
        session: ctx.host.id(),
        opId,
        intentId: op.uid,
        incarnation: op.incarnation,
        inputHash: op.inputHash,
        cmd: op.command,
      });
      if (p.kind === "prepared") m = "prepared";
      else if (p.kind === "duplicate") {
        m = mapStatus(p.status);
        if (m === "missing") m = { k: "terminal", status: "unknown" };
      } else m = { k: "terminal", status: "unknown", reason: p.kind };
    }
    if (m === "prepared") {
      // A stop that arrived meanwhile wins: nothing is started after it (the interrupt cancels the prepared operation).
      if (await ctx.host.tx((sql) => num(sql.exec("SELECT COALESCE(MAX(interrupted), 0) AS i FROM loop_turn WHERE turn_id = ?", ctx.turnId)[0]!.i) === 1)) {
        return { k: "wait" };
      }
      const s = await ex.start(opId, epoch);
      if (s.kind === "stale_epoch") throw new SupersededError();
      if (s.kind === "expired") return { k: "terminal", status: "unknown", reason: "expired" };
      if (s.kind === "duplicate") m = mapStatus(s.status);
      else m = mapStatus(await ex.status(opId));
      if (m === "missing" || m === "prepared") return { k: "wait" };
    }
    return m;
  }

  async #ackAll(host: Host, opIds: string[]): Promise<void> {
    const ex = this.#executor(host);
    for (const id of opIds) {
      try {
        const r = await ex.ack(id as Parameters<Executor["ack"]>[0], host.epoch());
        if (r.kind === "stale_epoch") return;
        if (r.kind === "acked") {
          await host.tx((sql) => sql.exec("UPDATE pending_op SET acked = 1 WHERE op_id = ?", id));
          await host.commit();
        }
      } catch {
        // The ack is retried by the sweep. The tombstone and the result stay at the executor.
      }
    }
  }

  /**
   * Accept and discard the late results of operations that the user stopped
   * (guide 7.3, D5), and acknowledge results that were recorded but not
   * acknowledged. A running operation gets its cancel again.
   */
  async sweep(host: Host): Promise<number> {
    const rows = await host.tx((sql) =>
      sql.exec("SELECT op_id, status, discard FROM pending_op WHERE acked = 0 AND (discard = 1 OR status != 'pending') AND status != 'unknown'"),
    );
    if (rows.length === 0) return 0;
    await this.fence(host);
    const ex = this.#executor(host);
    let n = 0;
    for (const r of rows) {
      const opId = str(r.op_id) as Parameters<Executor["status"]>[0];
      let s = await ex.status(opId);
      if (!isTerminalName(s.status) && num(r.discard) === 1) {
        // The user stopped it: send the cancel again, then read the end.
        await ex.cancel(opId, host.epoch());
        s = await ex.status(opId);
      }
      if (!isTerminalName(s.status)) continue;
      await this.#ackAll(host, [str(r.op_id)]);
      n += 1;
    }
    return n;
  }

  // ------------------------------------------------------------ interrupt, unknown

  /** A stop request: abort, drop the partial output, cancel the running operations (guide 6.3, D5). */
  async #interrupt(ctx: TurnContext, snap: Snapshot): Promise<void> {
    await this.#abandon(ctx, snap, { finish: { status: "done", text: "interrupted" }, recorded: [], ask: false });
  }

  /**
   * End the turn while tool calls are open. Every unanswered tool call gets a
   * result, so a call and its result are never split. Running operations are
   * marked `discard` and get a cancel; their late result is acknowledged and
   * dropped by `sweep`.
   */
  async #abandon(
    ctx: TurnContext,
    snap: Snapshot,
    o: {
      finish: { status: "done" | "failed" | "unknown"; text: string };
      recorded: Array<{ op: OpRow; out: Extract<OpOutcome, { k: "terminal" }> }>;
      ask: boolean;
    },
  ): Promise<void> {
    const recorded = new Map(o.recorded.map((r) => [r.op.uid, r]));
    const messages: NewMessage[] = o.recorded.map(({ op, out }) => toolMessage(op, out));
    const all = [...snap.messages, ...messages];
    const a = analyze(all);
    const reason = o.finish.status === "unknown" ? "the outcome of an earlier command is unknown" : "the turn was interrupted";
    if (a.kind === "tools") {
      for (const { call, uid } of a.unresolved) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: reason, status: "cancelled" }),
          toolCallId: call.id,
          toolCallUid: uid,
          toolName: call.function.name,
          messageUid: `${uid}:r`,
        });
      }
    }
    const open = snap.ops.filter((op) => !recorded.has(op.uid));
    const settle = [
      ...(snap.call?.pendingId ? [{ id: snap.call.pendingId, result: "cancelled" }] : []),
      ...snap.ops.flatMap((op) => (op.pendingId ? [{ id: op.pendingId, result: "abandoned" }] : [])),
    ];
    const now = this.#deps.clock.now();
    const promptHash = await this.promptHash();
    await ctx.step({
      settle,
      write: (sql, outbox) => {
        if (!turnIsOpen(sql, ctx.turnId)) throw new StepRaced();
        ensureSession(sql, { id: snap.sessionId, source: "teenytiny", model: this.#cfg.model, systemPrompt: this.#cfg.systemPrompt, systemPromptHash: promptHash }, now);
        for (const m of messages) insertMessage(sql, snap.sessionId, m, now);
        for (const { op, out } of o.recorded) {
          sql.exec("UPDATE pending_op SET status = ?, updated_at = ? WHERE op_id = ?", out.status, now, op.opId);
        }
        for (const op of open) sql.exec("UPDATE pending_op SET status = 'cancelled', discard = 1, updated_at = ? WHERE op_id = ?", now, op.opId);
        if (snap.call) sql.exec("UPDATE pending_call SET status = 'cancelled', updated_at = ? WHERE call_id = ? AND status = 'pending'", now, snap.call.callId);
        const text = o.ask
          ? `${o.finish.text}. It may or may not have run. Check the workspace and tell me how to go on.`
          : o.finish.status === "done"
            ? "Stopped."
            : `error: ${o.finish.text}`;
        this.#reply(outbox, ctx.turnId, text);
        this.#sessionUpsert(sql, outbox, snap.sessionId, o.finish.status, now);
      },
      finish: o.finish,
    });
    // The effect on the executor comes after the commit: cancel, then accept the late result.
    const ex = this.#executor(ctx.host);
    await this.#ackAll(ctx.host, o.recorded.filter((r) => r.out.status !== "unknown").map((r) => r.op.opId));
    for (const op of open) {
      try {
        await ex.cancel(op.opId as Parameters<Executor["cancel"]>[0], ctx.host.epoch());
      } catch {
        // The sweep sends the cancel again.
      }
    }
    await this.sweep(ctx.host).catch(() => 0);
  }

  // ------------------------------------------------------------ outbox rows

  #reply(outbox: OutboxWriter, turnId: string, text: string): void {
    if (this.#cfg.replyTarget) outbox.enqueue(this.#cfg.replyTarget, "deliver", { kind: "reply", turn: turnId, text });
  }

  #sessionUpsert(sql: Sql, outbox: OutboxWriter, sessionId: string, status: string, nowMs: number): void {
    if (!this.#cfg.profileTarget) return;
    const s = sql.exec("SELECT message_count, title, started_at FROM sessions WHERE id = ?", sessionId)[0];
    outbox.enqueue(this.#cfg.profileTarget, "session_upsert", {
      sessionId,
      status,
      messageCount: s ? num(s.message_count) : 0,
      title: s && typeof s.title === "string" ? s.title : null,
      startedAt: s ? num(s.started_at) : nowMs / 1000,
      lastActivityAt: nowMs / 1000,
    });
  }
}

// ---------------------------------------------------------------- pure helpers

function turnIsOpen(sql: Sql, turnId: string): boolean {
  return sql.exec("SELECT 1 AS x FROM turns WHERE id = ? AND status = 'open'", turnId).length > 0;
}

type Analysis =
  | { kind: "model_call" }
  | { kind: "finish"; text: string }
  | { kind: "tools"; calls: ToolCallWire[]; unresolved: Array<{ call: ToolCallWire; uid: string }> };

/** Read the transcript and say what comes next. */
export function analyze(msgs: NewMessage[]): Analysis {
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i]!.role !== "assistant") i--;
  if (i < 0) return { kind: "model_call" };
  const asst = msgs[i]!;
  const after = msgs.slice(i + 1);
  if (after.some((m) => m.role === "user")) return { kind: "model_call" };
  const calls = asst.toolCalls ?? [];
  if (calls.length === 0) return after.length === 0 ? { kind: "finish", text: asst.content ?? "" } : { kind: "model_call" };
  const answered = new Set(after.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  const unresolved = calls
    .map((call, j) => ({ call, uid: asst.toolCallUids?.[j] ?? `${asst.messageUid}#${j}` }))
    .filter((c) => !answered.has(c.call.id));
  return unresolved.length > 0 ? { kind: "tools", calls, unresolved } : { kind: "model_call" };
}

function isTerminalName(s: OpStatus["status"]): boolean {
  return s === "done" || s === "failed" || s === "cancelled" || s === "unknown" || s === "expired";
}

/** Map an executor status to the actor's view. `missing` means "the executor has no usable record". */
function mapStatus(s: OpStatus): OpOutcome | "prepared" | "missing" {
  switch (s.status) {
    case "done":
      return { k: "terminal", status: "done", result: s.result };
    case "failed":
      return { k: "terminal", status: "failed", result: s.result, reason: s.reason };
    case "cancelled":
      return { k: "terminal", status: "cancelled" };
    case "expired":
      return { k: "terminal", status: "unknown", reason: "expired" };
    case "prepared":
      return "prepared";
    case "dispatching":
    case "running":
      return { k: "wait" };
    case "unknown":
      return "missing";
  }
}

function toolMessage(op: OpRow, out: Extract<OpOutcome, { k: "terminal" }>): NewMessage {
  const content =
    out.status === "done" || out.status === "failed"
      ? terminalResult(out.result, out.status === "failed")
      : JSON.stringify({ error: out.status === "cancelled" ? "the command was cancelled" : "the outcome is unknown", status: out.status });
  return { role: "tool", content, toolCallId: op.toolCallId, toolCallUid: op.uid, toolName: op.toolName, messageUid: `${op.uid}:r` };
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
