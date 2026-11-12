/**
 * Read a Hermes plugin.yaml and decide where the plugin code runs.
 */
import { parseYaml, type YamlValue } from "./yaml.ts";

export type PluginRuntime = "portable" | "js" | "python";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export interface PluginManifest {
  name: string;
  /** Always a string. YAML numbers such as `1.0` are turned into text. */
  version: string;
  description: string | undefined;
  /** The `runtime:` key if the manifest has one. */
  runtime: PluginRuntime | undefined;
  providesTools: string[];
  providesHooks: string[];
  capabilities: string[];
  /** Hermesd extension: tools the manifest marks as having no effect. */
  pureTools: string[];
  /** Hermesd extension: hooks the manifest marks as having no effect. */
  pureHooks: string[];
  /** Every key that this code does not know. Kept as it was read. */
  extra: Record<string, YamlValue>;
}

const KNOWN_KEYS = new Set([
  "name",
  "version",
  "description",
  "runtime",
  "provides_tools",
  "provides_hooks",
  "capabilities",
  "pure_tools",
  "pure_hooks",
]);

function stringList(value: YamlValue | undefined, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) throw new ManifestError(`${key} must be a list`);
  return value.map((v) => {
    if (typeof v !== "string") throw new ManifestError(`${key} must hold only strings`);
    return v;
  });
}

export function parseManifest(text: string): PluginManifest {
  const doc = parseYaml(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ManifestError("plugin.yaml must be a mapping");
  }
  const name = doc["name"];
  if (typeof name !== "string" || name === "") throw new ManifestError("plugin.yaml needs a name");
  const rawVersion = doc["version"];
  const version = rawVersion === undefined || rawVersion === null ? "" : String(rawVersion);
  const runtime = doc["runtime"];
  if (runtime !== undefined && runtime !== null && runtime !== "portable" && runtime !== "js" && runtime !== "python") {
    throw new ManifestError(`runtime must be js, python or portable, not ${String(runtime)}`);
  }
  const description = doc["description"];
  const extra: Record<string, YamlValue> = {};
  for (const [k, v] of Object.entries(doc)) if (!KNOWN_KEYS.has(k)) extra[k] = v;
  return {
    name,
    version,
    description: typeof description === "string" ? description : undefined,
    runtime: (runtime ?? undefined) as PluginRuntime | undefined,
    providesTools: stringList(doc["provides_tools"], "provides_tools"),
    providesHooks: stringList(doc["provides_hooks"], "provides_hooks"),
    capabilities: stringList(doc["capabilities"], "capabilities"),
    pureTools: stringList(doc["pure_tools"], "pure_tools"),
    pureHooks: stringList(doc["pure_hooks"], "pure_hooks"),
    extra,
  };
}

const JS_EXT = /\.(js|mjs|cjs|ts)$/;

/**
 * Decide the runtime. The manifest `runtime:` key wins. Without it, use the
 * same file rule as the upstream survey: any .py file means python; else any
 * JS file or a package.json means js; else portable.
 */
export function classifyPlugin(manifest: PluginManifest, files: readonly string[]): PluginRuntime {
  if (manifest.runtime) return manifest.runtime;
  if (files.some((f) => f.endsWith(".py"))) return "python";
  if (files.some((f) => JS_EXT.test(f) || f.endsWith("package.json"))) return "js";
  return "portable";
}
