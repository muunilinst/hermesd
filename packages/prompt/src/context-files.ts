import { CONTEXT_FILE_MAX_CHARS } from "./upstream-text.ts";
import { scanForThreats } from "./threat.ts";

/**
 * Context files in the system prompt: SOUL.md and the project files
 * (.hermes.md, AGENTS.md, CLAUDE.md, .cursorrules).
 *
 * Port of upstream `agent/prompt_builder.py`: `_scan_context_content`,
 * `_truncate_content`, `_omitted_headings`, `load_soul_md`, `_context_section`,
 * `_strip_yaml_frontmatter`, `_load_hermes_md`, `_load_agents_md`,
 * `_load_claude_md`, `_load_cursorrules` and `build_context_files_prompt`.
 *
 * The port has no file system in the actor. The caller finds and reads the
 * files, and passes them as data (`ProjectContextFiles`). The choice between
 * the file types, the order, the scan, the cut and the text are upstream's.
 */

const HEAD_RATIO = 0.7;
const TAIL_RATIO = 0.2;
const CHARS_PER_TOKEN = 4;
// Dynamic cap (upstream _CONTEXT_FILE_WINDOW_FRACTION and _CONTEXT_FILE_DYNAMIC_CEILING).
const WINDOW_FRACTION = 0.06;
const DYNAMIC_CEILING = 500_000;

/** One candidate file that the caller has read. An empty `content` means empty or unreadable. */
export interface ContextFile {
  /** The label in the prompt (upstream: the file name or the path relative to the working directory). */
  label: string;
  /** The path that the model is told to read for the full text. */
  path: string;
  content: string;
}

/** The candidates of each project file type, in upstream's discovery order inside a type. */
export interface ProjectContextFiles {
  /** `.hermes.md` / `HERMES.md`: the nearest match. At most one entry is used. */
  hermesMd?: ContextFile[];
  /** The AGENTS.md chain from the git root down to the working directory. */
  agentsMd?: ContextFile[];
  /** `CLAUDE.md` / `claude.md`. */
  claudeMd?: ContextFile[];
  /** `.cursorrules` and `.cursor/rules/*.mdc`. */
  cursorrules?: ContextFile[];
  /** The working directory. Used for the path of the merged AGENTS.md chain. */
  cwd?: string;
}

export interface ContextBuildResult {
  text: string;
  /** Truncation warnings. Upstream shows them in the chat. */
  warnings: string[];
}

/** Upstream `_dynamic_context_file_max_chars`. */
export function dynamicContextFileMaxChars(contextLength: number | undefined): number {
  if (contextLength === undefined || !Number.isInteger(contextLength) || contextLength <= 0) return CONTEXT_FILE_MAX_CHARS;
  const budget = Math.trunc(contextLength * CHARS_PER_TOKEN * WINDOW_FRACTION);
  return Math.max(CONTEXT_FILE_MAX_CHARS, Math.min(budget, DYNAMIC_CEILING));
}

/** Upstream `_scan_context_content`. A hit blocks the file, unless it is the user's own SOUL.md. */
export function scanContextContent(content: string, filename: string, opts: { userAuthored?: boolean } = {}): string {
  const text = content.startsWith("﻿") ? content.slice(1) : content;
  const findings = scanForThreats(text);
  if (findings.length === 0) return text;
  if (opts.userAuthored) return text;
  return `[BLOCKED: ${filename} contained potential prompt injection (${findings.join(", ")}). Content not loaded.]`;
}

/** Upstream `_omitted_headings`. */
function omittedHeadings(content: string, start: number, end: number, limit = 15): string[] {
  const headings: string[] = [];
  let offset = 0;
  let fenced = false;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const stripped = line.trim();
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) fenced = !fenced;
    else if (!fenced && start <= offset && offset < end && /^#{1,6} \S/.test(stripped)) headings.push(stripped.replace(/^#+/, "").trim());
    offset += line.length;
  }
  return headings.length > limit ? [...headings.slice(0, limit), "..."] : headings;
}

/** Upstream `_truncate_content`: head and tail with a marker in the middle. */
export function truncateContent(
  content: string,
  filename: string,
  opts: { maxChars?: number; contextLength?: number; readPath?: string; warnings?: string[] } = {},
): string {
  const maxChars = opts.maxChars ?? dynamicContextFileMaxChars(opts.contextLength);
  if (content.length <= maxChars) return content;
  const remedy = "trim the file, pin a larger context_file_max_chars, or use a larger-context model!";
  opts.warnings?.push(`⚠️  Context file ${filename} TRUNCATED: ${content.length} chars exceeds limit of ${maxChars} — ${remedy}`);
  const headChars = Math.trunc(maxChars * HEAD_RATIO);
  const tailChars = Math.trunc(maxChars * TAIL_RATIO);
  const omitted = omittedHeadings(content, headChars, content.length - tailChars);
  const sections = omitted.length > 0 ? ` Omitted sections: ${omitted.join("; ")}.` : "";
  const marker =
    `\n\n[...truncated ${filename}: kept ${headChars}+${tailChars} of ${content.length} chars. The middle is ` +
    `omitted.${sections} If you need the full instructions, read the complete file with the read_file ` +
    `tool: ${opts.readPath ?? filename}]\n\n`;
  return content.slice(0, headChars) + marker + content.slice(content.length - tailChars);
}

/** Upstream `load_soul_md`: SOUL.md after the scan and the cut. Null when it is empty. */
export function loadSoulMd(
  raw: string | null | undefined,
  opts: { contextLength?: number; path?: string; userAuthored?: boolean; warnings?: string[] } = {},
): string | null {
  const content = (raw ?? "").trim();
  if (!content) return null;
  const scanned = scanContextContent(content, "SOUL.md", { userAuthored: opts.userAuthored ?? true });
  return truncateContent(scanned, "SOUL.md", {
    ...(opts.contextLength !== undefined ? { contextLength: opts.contextLength } : {}),
    readPath: opts.path ?? "SOUL.md",
    ...(opts.warnings ? { warnings: opts.warnings } : {}),
  });
}

/** Upstream `_strip_yaml_frontmatter`. */
function stripYamlFrontmatter(content: string): string {
  const text = content.replace(/^﻿+/, "");
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  if (end === -1) return text;
  const body = text.slice(end + 4).replace(/^\n+/, "");
  return body || text;
}

/** Upstream `_context_section`. */
function contextSection(content: string, label: string, warnName: string, path: string, ctx: Ctx): string {
  const body = `## ${label}\n\n${scanContextContent(content, label)}`;
  return truncateContent(body, warnName, { ...ctx.opts, readPath: path });
}

interface Ctx {
  opts: { contextLength?: number; warnings: string[] };
}

function firstNonEmpty(files: ContextFile[] | undefined): ContextFile | undefined {
  return files?.find((f) => f.content !== "");
}

function loadHermesMd(files: ProjectContextFiles, ctx: Ctx): string {
  const f = firstNonEmpty(files.hermesMd?.slice(0, 1));
  return f ? contextSection(stripYamlFrontmatter(f.content), f.label, ".hermes.md", f.path, ctx) : "";
}

function loadAgentsMd(files: ProjectContextFiles, ctx: Ctx): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const f of files.agentsMd ?? []) {
    if (f.content && !seen.has(f.content)) {
      seen.add(f.content);
      sections.push(contextSection(f.content, f.label, f.label, f.path, ctx));
    }
  }
  if (sections.length <= 1) return sections[0] ?? "";
  // The merged chain is capped too, so a deep monorepo cannot multiply the budget.
  return truncateContent(sections.join("\n\n"), "AGENTS.md (directory chain)", { ...ctx.opts, readPath: `${files.cwd ?? "."}/AGENTS.md` });
}

function loadClaudeMd(files: ProjectContextFiles, ctx: Ctx): string {
  const f = firstNonEmpty(files.claudeMd);
  return f ? contextSection(f.content, f.label, "CLAUDE.md", f.path, ctx) : "";
}

function loadCursorrules(files: ProjectContextFiles, ctx: Ctx): string {
  const body = (files.cursorrules ?? [])
    .filter((f) => f.content)
    .map((f) => `## ${f.label}\n\n${scanContextContent(f.content, f.label)}\n\n`)
    .join("");
  if (!body) return "";
  return truncateContent(body, ".cursorrules", { ...ctx.opts, readPath: `${files.cwd ?? "."}/.cursorrules` });
}

/**
 * Upstream `build_context_files_prompt`. Only one project type loads: the first
 * of .hermes.md, AGENTS.md, CLAUDE.md, .cursorrules that has a non-empty file.
 * SOUL.md is separate. It is added unless `skipSoul` is set (it is then the
 * identity slot already).
 */
export function buildContextFilesPrompt(input: {
  files?: ProjectContextFiles;
  soul?: string | null;
  skipSoul: boolean;
  contextLength?: number;
}): ContextBuildResult {
  const warnings: string[] = [];
  const ctx: Ctx = { opts: { ...(input.contextLength !== undefined ? { contextLength: input.contextLength } : {}), warnings } };
  const files = input.files ?? {};
  const sections: string[] = [loadHermesMd(files, ctx) || loadAgentsMd(files, ctx) || loadClaudeMd(files, ctx) || loadCursorrules(files, ctx)];
  if (!input.skipSoul && input.soul) sections.push(input.soul);
  const kept = sections.filter((s) => s !== "");
  if (kept.length === 0) return { text: "", warnings };
  return {
    text: "# Project Context\n\nThe following project context files have been loaded and should be followed:\n\n" + kept.join("\n"),
    warnings,
  };
}
