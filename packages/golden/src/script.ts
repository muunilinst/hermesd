import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ApiMode, ScriptStep } from "@hermesd/providers";

/**
 * A golden-transcript script (guide 7.2): the scripted model answers, the user
 * inputs, the config and the expected outcome of one scenario. It is plain JSON,
 * so the same file drives the port runner and the upstream recording.
 */

/** A long plain text. `{lorem: n}` is `prefix` and then filler, `n` characters in all. */
export interface LoremText {
  prefix?: string;
  lorem: number;
}

export type InputText = string | LoremText;

export interface ScriptInput {
  /** The user text. The input waits for the reply of its turn. */
  send: InputText;
  /**
   * Stop the turn at this point instead of waiting for it to end.
   * `model_call`: while the model request is held. `tool_running`: while a tool command runs.
   * The stop reply is awaited, then every hold is released.
   */
  interrupt?: "model_call" | "tool_running";
}

/** What a plugin hook callback does. */
export type HookBehavior =
  | { kind: "block"; message: string }
  | { kind: "throw"; error: string; message: string }
  | { kind: "hang" }
  | { kind: "none" };

export interface HookPlugin {
  /** The plugin name (manifest `name`). */
  name: string;
  /** The directory name. Hook results are ordered by it. */
  dir: string;
  hook: "pre_tool_call";
  /** The callback name, as the error text shows it (Python `__name__`). */
  callback: string;
  behavior: HookBehavior;
}

export interface FallbackTarget {
  mode: ApiMode;
  model: string;
  stream?: boolean;
  steps: ScriptStep[];
}

export interface CompressionKnobs {
  thresholdPercent?: number;
  minimumContextLength?: number;
  smallContextWindowLimit?: number;
}

export interface Script {
  name: string;
  purpose: string;
  /** The guide behavior this script covers. */
  guide: string;
  mode: ApiMode;
  stream?: boolean;
  /** The model name in the request. Default: the model of the mode in `@hermesd/providers`. */
  model?: string;
  /** Scripted model answers, in order. */
  steps: ScriptStep[];
  fallback?: FallbackTarget;
  config?: {
    contextWindow?: number;
    compression?: CompressionKnobs;
    tools?: string[];
    systemPrompt?: string;
  };
  /** A shell command string as the model writes it, to the result the simulated command gives. */
  commands?: Record<string, { stdout?: string; exitCode?: number; hold?: string }>;
  hooks?: { timeoutMs?: number; plugins: HookPlugin[] };
  inputs: ScriptInput[];
  /** A fault injected into the port run. */
  fault?: { kind: "persistence_failure_after_model" };
  expect: {
    /** The text of each reply the user got, in order. */
    replies: string[];
    /** Requests that reached the model (retries count). */
    requests: number;
    /** Tool commands that ran in the executor. */
    toolRuns: number;
    /** The hook log lines (`kind:plugin`), in order. */
    hookLog?: string[];
  };
  upstream: {
    /** How to produce this scenario upstream, when it is more than "run the inputs". */
    procedure?: string;
    /** True if a driver cannot do it alone and a person must act. */
    manual?: boolean;
    /** Field paths to ignore when comparing with upstream (see compare.ts). */
    ignore?: string[];
  };
}

export const SCRIPTS_DIR = new URL("../scripts/", import.meta.url).pathname;
export const PORT_DIR = new URL("../transcripts/port/", import.meta.url).pathname;
export const UPSTREAM_DIR = new URL("../transcripts/upstream/", import.meta.url).pathname;

/** The text of a user input. The same function exists in `scripted-server/expand.mjs`. */
export function expandText(t: string | LoremText): string {
  if (typeof t === "string") return t;
  const prefix = t.prefix ?? "";
  const body = "lorem ipsum dolor ".repeat(Math.ceil(t.lorem / 18)).slice(0, t.lorem);
  return prefix + body;
}

export function scriptNames(dir = SCRIPTS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
    .sort();
}

export function loadScript(name: string, dir = SCRIPTS_DIR): Script {
  const script = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Script;
  validateScript(script, name);
  return script;
}

/** Throws a plain message when a script is malformed. */
export function validateScript(s: Script, file: string): void {
  const fail = (msg: string): never => {
    throw new Error(`script ${file}: ${msg}`);
  };
  if (s.name !== file) fail(`name "${s.name}" does not match the file name`);
  if (!s.purpose || s.purpose.length > 160 || s.purpose.includes("\n")) fail("purpose must be one line of at most 160 characters");
  if (!s.guide) fail("guide is missing");
  if (!Array.isArray(s.steps) || s.steps.length === 0) fail("steps is empty");
  if (!Array.isArray(s.inputs) || s.inputs.length === 0) fail("inputs is empty");
  if (!s.expect || !Array.isArray(s.expect.replies) || typeof s.expect.requests !== "number" || typeof s.expect.toolRuns !== "number") fail("expect needs replies, requests and toolRuns");
  const commands = s.commands ?? {};
  for (const step of [...s.steps, ...(s.fallback?.steps ?? [])]) {
    for (const call of step.toolCalls ?? []) {
      if (call.name !== "terminal") continue;
      const args = (typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments) as { command?: unknown };
      if (typeof args.command === "string" && !(args.command in commands)) fail(`terminal command "${args.command}" is not in commands`);
    }
  }
}
