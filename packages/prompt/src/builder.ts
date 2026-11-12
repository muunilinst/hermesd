import { buildContextFilesPrompt, loadSoulMd, type ProjectContextFiles } from "./context-files.ts";
import { buildEnvironmentHints, type EnvironmentInfo } from "./environment.ts";
import { timestampLine } from "./timestamp.ts";
import {
  DEFAULT_AGENT_IDENTITY,
  EXECUTION_GUIDANCE_LINE_TOOLS,
  EXECUTION_GUIDANCE_MODELS,
  GOOGLE_MODEL_OPERATIONAL_GUIDANCE,
  HERMES_AGENT_HELP_GUIDANCE,
  HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS,
  OPENAI_MODEL_EXECUTION_GUIDANCE,
  PARALLEL_TOOL_CALL_GUIDANCE,
  PLATFORM_HINTS,
  RUNTIME_ENVIRONMENT_END,
  RUNTIME_ENVIRONMENT_HEADING,
  SESSION_SEARCH_GUIDANCE,
  SKILLS_GUIDANCE,
  STEER_CHANNEL_NOTE,
  TASK_COMPLETION_GUIDANCE,
  TELEGRAM_RICH_MESSAGES_HINT,
  TOOL_USE_ENFORCEMENT_GUIDANCE,
  TOOL_USE_ENFORCEMENT_MODELS,
} from "./upstream-text.ts";

/**
 * The system prompt builder.
 *
 * Port of upstream `agent/system_prompt.py` (`build_system_prompt_parts`,
 * `build_system_prompt` and the helpers it calls) and the text and guards of
 * `agent/prompt_builder.py`. The order of the parts, the text, and the
 * conditions are upstream's. The builder is a pure function of its input: it
 * reads no file, no clock and no environment variable. The caller supplies
 * everything as data (`PromptInput`).
 *
 * A feature that the port does not have is an input that is off by default
 * (no skills index, no memory blocks, no coding context, no bot mode, no
 * plugin sections). With it off, the builder emits what upstream emits when
 * the feature is off. See NOTES.md for the list.
 */

/** An upstream "gate" setting: true/false, a word like "on", a list of model-name parts, or "auto". */
export type Gate = boolean | string | string[];

const GATE_WORDS: Record<string, boolean> = { true: true, always: true, yes: true, on: true, false: false, never: false, no: false, off: false };

/** Upstream `system_prompt._model_gate`. */
export function modelGate(setting: Gate | undefined, model: string | undefined, defaultModels: readonly string[]): boolean {
  if (setting === true || setting === false) return setting;
  if (typeof setting === "string") {
    const word = GATE_WORDS[setting.toLowerCase()];
    if (word !== undefined) return word;
  }
  const m = (model ?? "").toLowerCase();
  if (Array.isArray(setting)) return setting.some((p) => typeof p === "string" && m.includes(p.toLowerCase()));
  return defaultModels.some((p) => m.includes(p));
}

/** The override of a platform hint (`platform_hints.<platform>` in config.yaml). */
export type HintOverride = string | { replace?: string; append?: string };

export interface PromptInput {
  /** `agent.model`. */
  model: string;
  /** `agent.provider`. */
  provider?: string;
  /** `agent.platform`: cli, tui, desktop, cron, api_server, or a plugin platform. */
  platform: string;
  /** `agent.session_id`. Printed when `passSessionId` is set. */
  sessionId?: string;
  passSessionId?: boolean;
  /** The id of the lineage root session. Its stamp gives the start date. */
  lineageRootId?: string;
  /** `agent.valid_tool_names`. */
  validToolNames: readonly string[];
  /** `agent.skip_context_files`. */
  skipContextFiles?: boolean;
  /** `agent.load_soul_identity`. */
  loadSoulIdentity?: boolean;
  /** `agent_is_oneshot(agent)`: a one-shot run has nobody to steer it. */
  oneshot?: boolean;
  /** `agent.tool_use_enforcement`. Default "auto". */
  toolUseEnforcement?: Gate;
  /** `agent.execution_guidance`. Default "auto". */
  executionGuidance?: Gate;
  /** Default true. */
  taskCompletionGuidance?: boolean;
  /** Default true. */
  parallelToolCallGuidance?: boolean;
  /** `agent._memory_enabled`. Default true. */
  memoryEnabled?: boolean;
  /** `agent._user_profile_enabled`. Default true. */
  userProfileEnabled?: boolean;
  /** The blocks that the built-in memory store formats for the prompt (memory, then user). Already filtered by the enable flags. */
  memoryBlocks?: readonly string[];
  /** The block of an external memory provider. */
  externalMemoryBlock?: string;
  /** The skills index (`build_skills_system_prompt`). Empty without skills tools. */
  skillsPrompt?: string;
  /** The `skills.auto_load` blocks. */
  autoLoadPrompt?: string;
  /** The text of SOUL.md, as read. */
  soul?: string | null;
  /** The project context files. */
  projectContext?: ProjectContextFiles;
  /** The model's context size. Scales the context-file cap. */
  contextLength?: number;
  /** Plugin hints for platforms that upstream's built-in table lacks (Telegram, Discord, ...). */
  pluginPlatformHints?: Record<string, string>;
  /** `agent._platform_hint_overrides`. */
  platformHintOverrides?: Record<string, HintOverride>;
  /** `platforms.telegram.extra.rich_messages`. */
  telegramRichMessages?: boolean;
  /** `HERMES_CRON_AUTO_DELIVER_PLATFORM`: the delivery channel of a cron job. */
  cronDeliverPlatform?: string;
  /** `HERMES_DESKTOP_TERMINAL`. */
  desktopTerminal?: boolean;
  /** The caller's own system message (`ephemeral_system_prompt`). It leads the context tier. */
  systemMessage?: string;
  /** The Hermes profile. `name` "default" or a profile name. `home` is the home of this session, `defaultRoot` the root of the default profile. */
  profile: { name: string; home: string; defaultRoot: string };
  /** The clock. `now` and `sessionStart` are instants. `timeZone` is an IANA name. */
  clock: { now: Date; sessionStart?: Date; timeZone: string };
  environment: EnvironmentInfo;
}

export interface PromptTiers {
  stable: string;
  context: string;
  volatile: string;
  /** Context-file truncation warnings. */
  warnings: string[];
}

const TUI_EMBEDDED_PANE_CLARIFIER =
  " You're in its embedded terminal pane, beside the GUI chat — the user can " +
  "select your output (Option-drag on macOS, Shift-drag elsewhere) and press " +
  "Cmd/Ctrl+L to send it to the chat composer.";

/** Upstream `prompt_builder.execution_guidance_text`: drop the lines that name tools the session lacks. */
export function executionGuidanceText(validToolNames?: readonly string[]): string {
  let text = OPENAI_MODEL_EXECUTION_GUIDANCE;
  if (validToolNames) {
    const have = new Set(validToolNames);
    for (const [line, tools] of Object.entries(EXECUTION_GUIDANCE_LINE_TOOLS)) {
      if (!tools.some((t) => have.has(t))) text = text.replace(line, "");
    }
  }
  return text;
}

/**
 * Upstream `prompt_builder.build_memory_guidance`. Adapts the store and
 * skill-write guidance without widening what belongs in memory.
 */
export function buildMemoryGuidance(memoryEnabled = true, profileEnabled = true, skillManageAvailable = true): string {
  if (!memoryEnabled && !profileEnabled) return "";
  const frame = memoryEnabled
    ? "You have persistent memory, carried across sessions and loaded " +
      "into each new session's context; the memory tool's schema defines what belongs there. "
    : "You have a persistent user profile, carried across sessions and " +
      "loaded into each new session's context; save durable facts about the user with the " +
      "memory tool (target='user') — the built-in notes store is disabled, so never target='memory'. ";
  const skillRouting = skillManageAvailable
    ? "Skills come first: when you learn something while doing a task — a " +
      "procedure, a pitfall, and the user's preferences and corrections " +
      "for that kind of work — record it in the skill you used or built " +
      "for the task (skill_manage), where it loads only when relevant. "
    : "Task-specific knowledge — procedures, pitfalls, and the user's preferences " +
      "and corrections for that kind of work — belongs in skills, not in memory, " +
      "even when skill writing is unavailable. ";
  return (
    frame +
    skillRouting +
    "Memory is the narrow exception for facts that apply to EVERY " +
    "session regardless of task (who the user is, environment facts, " +
    "standing conventions with no task home); it has a hard character " +
    "budget, so when it fills, replace or consolidate stale entries " +
    "rather than skipping the save. Write entries as declarative facts, " +
    "not instructions to yourself: 'User prefers concise responses' ✓ — " +
    "'Always respond concisely' ✗ (imperative phrasing gets re-read as " +
    "a directive in later sessions and can override the user's current " +
    "request). A fact stale within a week belongs in session history; " +
    "procedures and workflows belong in skills."
  );
}

/** Upstream `system_prompt._tool_guidance_block`. Null when no block applies. */
function toolGuidanceBlock(a: PromptInput): string | null {
  const names = new Set(a.validToolNames);
  const blocks: Array<string | null> = [
    names.has("memory") ? buildMemoryGuidance(a.memoryEnabled ?? true, a.userProfileEnabled ?? true, names.has("skill_manage")) : null,
    names.has("session_search") ? SESSION_SEARCH_GUIDANCE : null,
    names.has("skill_manage") ? SKILLS_GUIDANCE : null,
    // The Kanban lifecycle guidance is for dispatcher workers. The port has none, so it is off.
    null,
  ];
  return blocks.filter((g): g is string => !!g).join(" ") || null;
}

/** Upstream `system_prompt._resolve_platform_hint`. */
function resolvePlatformHint(a: PromptInput, platformKey: string, defaultHint: string): string {
  let spec = platformKey ? a.platformHintOverrides?.[platformKey] : undefined;
  if (typeof spec === "string") spec = { append: spec };
  if (typeof spec !== "object" || spec === null) return defaultHint;
  const replaceText = typeof spec.replace === "string" ? spec.replace.trim() : "";
  const appendText = typeof spec.append === "string" ? spec.append.trim() : "";
  const base = replaceText || defaultHint;
  return appendText ? `${base}\n\n${appendText}`.trim() : base;
}

/** Upstream `system_prompt._default_platform_hint`: the built-in hint, else the plugin's hint, else "". */
function defaultPlatformHint(a: PromptInput, platformKey: string): string {
  const builtIn = (PLATFORM_HINTS as Record<string, string>)[platformKey];
  let hint = builtIn ?? (platformKey ? (a.pluginPlatformHints?.[platformKey] ?? "") : "");
  if (platformKey === "telegram" && hint && a.telegramRichMessages) hint = hint.replace(/\s+$/, "") + " " + TELEGRAM_RICH_MESSAGES_HINT;
  return hint;
}

/** Upstream `system_prompt.platform_hint`. */
export function platformHint(a: PromptInput): string {
  const platformKey = (a.platform ?? "").toLowerCase().trim();
  let effective = resolvePlatformHint(a, platformKey, defaultPlatformHint(a, platformKey));
  if (platformKey === "tui" && effective && !effective.includes(TUI_EMBEDDED_PANE_CLARIFIER) && a.desktopTerminal) {
    effective += TUI_EMBEDDED_PANE_CLARIFIER;
  }
  if (platformKey === "cron") {
    const deliverKey = (a.cronDeliverPlatform ?? "").toLowerCase().trim();
    if (deliverKey && deliverKey !== "cron") {
      const hint = resolvePlatformHint(a, deliverKey, defaultPlatformHint(a, deliverKey));
      const delivery = hint ? `Delivery destination (${deliverKey}): ${hint}` : "";
      if (delivery) effective = `${effective}\n\n${delivery}`.trim();
    }
  }
  return effective;
}

/** Upstream `system_prompt._guidance_parts`: universal, tool-aware and model-gated guidance. */
function guidanceParts(a: PromptInput): Array<string | null> {
  const parts: Array<string | null> = [];
  const hasTools = a.validToolNames.length > 0;
  if (hasTools) {
    if (a.taskCompletionGuidance ?? true) parts.push(TASK_COMPLETION_GUIDANCE);
    if (a.parallelToolCallGuidance ?? true) parts.push(PARALLEL_TOOL_CALL_GUIDANCE);
  }
  parts.push(toolGuidanceBlock(a));
  if (!hasTools) return parts;
  // Steering lands only inside tool results, so it is reachable only with tools. A one-shot has nobody to steer it.
  if (!a.oneshot) parts.push(STEER_CHANNEL_NOTE);
  if (modelGate(a.toolUseEnforcement ?? "auto", a.model, TOOL_USE_ENFORCEMENT_MODELS)) {
    parts.push(TOOL_USE_ENFORCEMENT_GUIDANCE);
    if (["gemini", "gemma"].some((g) => (a.model ?? "").toLowerCase().includes(g))) parts.push(GOOGLE_MODEL_OPERATIONAL_GUIDANCE);
  }
  if (modelGate(a.executionGuidance ?? "auto", a.model, EXECUTION_GUIDANCE_MODELS)) parts.push(executionGuidanceText(a.validToolNames));
  return parts;
}

/** Upstream `system_prompt._alibaba_identity_part`. */
function alibabaIdentityPart(a: PromptInput): string[] {
  if (a.provider !== "alibaba") return [];
  const short = a.model.slice(a.model.lastIndexOf("/") + 1);
  return [
    `You are powered by the model named ${short}. ` +
      `The exact model ID is ${a.model}. ` +
      `When asked what model you are, always answer based on this information, ` +
      `not on any model name returned by the API.`,
  ];
}

/** Upstream `system_prompt._active_profile_line`. */
function activeProfileLine(a: PromptInput): string {
  const { name, home, defaultRoot } = a.profile;
  if (name === "default") {
    return (
      "Active Hermes profile: default. Other profiles (if any) live " +
      "under " + defaultRoot + "/profiles/<name>/. Each profile has its own " +
      "skills/, plugins/, cron/, and memories/ that affect a different " +
      "session than this one. Do not modify another profile's " +
      "skills/plugins/cron/memories unless the user explicitly directs " +
      "you to."
    );
  }
  return (
    `Active Hermes profile: ${name}. This session reads ` +
    `and writes ${home}/. The default ` +
    `profile's data lives at ${defaultRoot}/skills/, ${defaultRoot}/plugins/, ` +
    `${defaultRoot}/cron/, ${defaultRoot}/memories/ — those belong to a ` +
    `different session run from a different shell. Do NOT modify ` +
    `another profile's skills/plugins/cron/memories unless the user ` +
    `explicitly directs you to.`
  );
}

/** Upstream `system_prompt._join_tier`: join the non-empty parts. */
function joinTier(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => !!p && p.trim() !== "")
    .map((p) => p.trim())
    .join("\n\n");
}

/**
 * Upstream `system_prompt.build_system_prompt_parts`: the prompt as three
 * ordered cache tiers.
 *
 * - stable: identity, help text, guidance, the platform hint.
 * - context: the caller's system message and the project context files.
 * - volatile: skills index, memory, profile line, timestamp, runtime environment.
 */
export function buildSystemPromptParts(a: PromptInput): PromptTiers {
  const warnings: string[] = [];
  const hasSkillTools = ["skills_list", "skill_view", "skill_manage"].some((n) => a.validToolNames.includes(n));
  // Stable tier. SOUL.md is the identity when it exists (cron keeps it while it skips cwd files).
  const wantsSoul = (a.loadSoulIdentity ?? false) || !(a.skipContextFiles ?? false);
  const soul = wantsSoul ? loadSoulMd(a.soul, { ...(a.contextLength !== undefined ? { contextLength: a.contextLength } : {}), warnings }) : null;
  const stable: Array<string | null> = [soul ? soul : DEFAULT_AGENT_IDENTITY];
  const soulLoaded = !!soul;
  // The skill_view() pointer dangles without skill tools or without the hermes-agent skill, so the
  // variant is chosen after the skills index is known. This slot holds its place.
  const helpSlot = stable.length;
  stable.push(HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS);
  stable.push(...guidanceParts(a));
  const skillsPrompt = hasSkillTools ? (a.skillsPrompt ?? "") : "";
  if (a.validToolNames.includes("skill_view") && skillsPrompt.includes("- hermes-agent:")) stable[helpSlot] = HERMES_AGENT_HELP_GUIDANCE;
  stable.push(...alibabaIdentityPart(a));
  // Pinned skills are per-agent constants. Same gate as the skills index, and none for agents that skip context files.
  if (!(a.skipContextFiles ?? false) && hasSkillTools && a.autoLoadPrompt) stable.push(a.autoLoadPrompt);
  // The coding posture is not in the port: no prefix, no workspace block, no trailing part. So the post-workspace
  // parts follow in the stable tier (upstream's placement for sessions without a workspace snapshot).
  // Environment probe and Bot Mode parts are off. The platform hint stays.
  stable.push(platformHint(a));

  // Context tier.
  const context: Array<string | null> = [];
  if (a.systemMessage !== undefined) context.push(a.systemMessage);
  if (!(a.skipContextFiles ?? false)) {
    const built = buildContextFilesPrompt({
      ...(a.projectContext ? { files: a.projectContext } : {}),
      soul,
      skipSoul: soulLoaded,
      ...(a.contextLength !== undefined ? { contextLength: a.contextLength } : {}),
    });
    warnings.push(...built.warnings);
    context.push(built.text);
  }

  // Volatile tier.
  const volatile: Array<string | null> = [skillsPrompt, ...(a.memoryBlocks ?? [])];
  if (a.externalMemoryBlock) volatile.push(a.externalMemoryBlock);
  // The plugin sections are off. The profile line names this home's path, so it rides in the volatile tier.
  volatile.push(activeProfileLine(a));
  volatile.push(
    timestampLine({
      now: a.clock.now,
      ...(a.clock.sessionStart ? { sessionStart: a.clock.sessionStart } : {}),
      timeZone: a.clock.timeZone,
      candidateIds: [a.lineageRootId, a.sessionId],
      trailer: [
        ["Session ID", a.passSessionId ? a.sessionId : undefined],
        ["Model", a.model],
        ["Provider", a.provider],
        ["Platform", a.platform],
      ],
    }),
  );
  let hints = buildEnvironmentHints(a.environment);
  if (hints) {
    // Embedder hints are prose too; the delimiter is reserved for the renderer.
    hints = hints.split(RUNTIME_ENVIRONMENT_HEADING).join("> " + RUNTIME_ENVIRONMENT_HEADING);
    volatile.push(`${RUNTIME_ENVIRONMENT_HEADING}\n\n${hints}\n\n${RUNTIME_ENVIRONMENT_END}`);
  }
  return { stable: joinTier(stable), context: joinTier(context), volatile: joinTier(volatile), warnings };
}

/** Upstream `system_prompt.build_system_prompt`: the three tiers joined by blank lines. */
export function buildSystemPrompt(a: PromptInput): string {
  const t = buildSystemPromptParts(a);
  return [t.stable, t.context, t.volatile].filter((p) => p).join("\n\n");
}
