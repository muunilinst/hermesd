import { TOOL_SCHEMAS } from "@hermesd/contracts/tool-schemas";
import { TERMINAL_SCHEMA } from "./provisional-schemas.ts";

/**
 * The tools of milestone 1: clarify, todo and terminal (guide 6.5).
 *
 * The schema is data. For `clarify` and `todo` it comes unchanged from
 * `contracts/upstream/tool-schemas.json`. For `terminal` it comes from
 * `provisional-schemas.ts`, because the extractor has no literal for it.
 * Upstream names its todo tool `todo_list` at the pinned commit, so the port
 * keeps that name.
 */

export type ToolName = "clarify" | "todo_list" | "terminal" | "session_search";

export const SUPPORTED_TOOLS: readonly ToolName[] = ["terminal", "todo_list", "clarify"];

/**
 * Tools that exist but are off by default. `session_search` needs the profile
 * actor. A config turns it on with `tools: [...SUPPORTED_TOOLS, "session_search"]`.
 * It is not in `SUPPORTED_TOOLS`, so the requests of the golden record do not change.
 */
export const OPTIONAL_TOOLS: readonly ToolName[] = ["session_search"];

export interface ToolDef {
  name: ToolName;
  /** The schema the model sees: `{name, description, parameters}`. */
  schema: Record<string, unknown>;
  /** True if the schema is a stand-in and not upstream's literal. */
  provisional: boolean;
  /** Where the schema comes from. */
  source: string;
  /** An interactive tool waits for the user. It runs alone, in order (guide 6.3). */
  interactive: boolean;
}

/** One entry of the `tools` list of an OpenAI chat_completions request. */
export interface OpenAiTool {
  type: "function";
  function: Record<string, unknown>;
}

let cache: Record<ToolName, ToolDef> | undefined;

export function loadToolDefs(): Record<ToolName, ToolDef> {
  if (cache) return cache;
  const surface = TOOL_SCHEMAS;
  const literal = (name: ToolName): ToolDef => {
    const entry = surface.tools.find((t) => t.name === name);
    if (!entry) throw new Error(`tool ${name} has no literal schema in tool-schemas.json`);
    return { name, schema: entry.schema, provisional: false, source: `${entry.file}:${entry.line}`, interactive: name === "clarify" };
  };
  cache = {
    clarify: literal("clarify"),
    todo_list: literal("todo_list"),
    session_search: literal("session_search"),
    terminal: { name: "terminal", schema: TERMINAL_SCHEMA.schema, provisional: true, source: TERMINAL_SCHEMA.source, interactive: false },
  };
  return cache;
}

/** The `tools` field of a request, for the tools that are supported. */
export function toolDefinitions(names: readonly ToolName[] = SUPPORTED_TOOLS): OpenAiTool[] {
  const defs = loadToolDefs();
  return names.map((n) => ({ type: "function", function: defs[n].schema }));
}

export function isToolName(name: string): name is ToolName {
  return name === "clarify" || name === "todo_list" || name === "terminal" || name === "session_search";
}
