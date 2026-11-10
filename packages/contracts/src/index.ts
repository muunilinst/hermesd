import { readFileSync } from "node:fs";

/**
 * Readers for the committed upstream contract files.
 * The files are produced by contracts/extract/run.py (see contracts/README.md).
 */

const CONTRACTS = new URL("../../../contracts/", import.meta.url);

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

export type JsonObject = Record<string, unknown>;

export interface Pin {
  repository: string;
  commit: string;
  commitDate: string;
  stateSchemaVersion: number;
}

export interface ExtractedTable {
  name: string;
  kind: "table" | "virtual";
  file: string;
  line: number;
  created_lazily: boolean;
}

export interface StateSchemaSurface {
  upstream_commit: string | null;
  schema_version: number | null;
  counts: Record<string, number>;
  tables: ExtractedTable[];
}

export interface ToolEntry {
  name: string | null;
  toolset: string | null;
  file: string;
  line: number;
  schema: JsonObject;
}

export interface ToolSchemasSurface {
  upstream_commit: string | null;
  counts: Record<string, number>;
  tools: ToolEntry[];
  non_literal: { name: string | null; file: string; line: number; reason: string }[];
}

export interface HookAbiSurface {
  upstream_commit: string | null;
  counts: Record<string, number>;
  hook_names: string[];
}

export interface ManifestEntry {
  path: string;
  parsed: boolean;
  class: "portable" | "js" | "python";
}

export interface ManifestsSurface {
  upstream_commit: string | null;
  counts: Record<string, unknown>;
  manifests: ManifestEntry[];
}

export interface LedgerTable {
  present: boolean;
  status_set?: string[] | null;
  unique_constraints?: string[][];
  unique_indexes?: { name: string; columns: string[]; where: string | null }[];
  primary_key?: string[];
}

export interface LedgerSurface {
  upstream_commit: string | null;
  tables: Record<string, LedgerTable>;
}

export type Decision = "preserve" | "replace" | "not_supported";
export type Owner = "session" | "profile" | "gateway" | "executor";

export interface TableDecision {
  decision: Decision;
  owner: Owner;
  inGuide: boolean;
  note: string;
}

export const DECISIONS: readonly Decision[] = ["preserve", "replace", "not_supported"];
export const OWNERS: readonly Owner[] = ["session", "profile", "gateway", "executor"];

export function loadPin(): Pin {
  return readJson<Pin>(new URL("../../../upstream/pin.json", import.meta.url));
}

export type Surface = "tool-schemas" | "hook-abi" | "manifests" | "state-schema" | "ledger";

export function loadSurface<T>(surface: Surface): T {
  return readJson<T>(new URL(`upstream/${surface}.json`, CONTRACTS));
}

export function loadTableDecisions(): Record<string, TableDecision> {
  return readJson<{ tables: Record<string, TableDecision> }>(new URL("table-decisions.json", CONTRACTS)).tables;
}

export function loadKnownHooks(): string[] {
  return readJson<{ hooks: string[] }>(new URL("known-hooks.json", CONTRACTS)).hooks;
}

/** Names in `a` that are not in `b`, sorted. */
export function missingFrom(a: Iterable<string>, b: Iterable<string>): string[] {
  const have = new Set(b);
  return [...new Set(a)].filter((x) => !have.has(x)).sort();
}
