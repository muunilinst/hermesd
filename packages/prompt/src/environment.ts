import { BACKEND_FALLBACK_DESCRIPTIONS, WSL_ENVIRONMENT_HINT } from "./upstream-text.ts";

/**
 * The environment hints of the system prompt.
 *
 * Port of upstream `agent/prompt_builder.py`: `build_environment_hints`,
 * `_local_host_hints`, `_remote_backend_hint` and `_embedder_environment_hint`.
 * Upstream reads the host from the process. The port takes it as data, because
 * the actor does not run on the machine whose tools it uses.
 *
 * Not ported: the Windows bash-shell hint, the Bot Screen note, and the live
 * probe of a remote backend (a caller may pass the probe text it got).
 */

/** Upstream `_REMOTE_TERMINAL_BACKENDS`. */
const REMOTE_BACKENDS = new Set(["docker", "modal", "daytona", "ssh", "vercel_sandbox", "managed_modal"]);

export interface EnvironmentInfo {
  /** `TERMINAL_ENV`. Default "local". */
  backend?: string;
  /** For a local backend: "Linux (6.1.0)" and so on. */
  host?: string;
  homeDir?: string;
  cwd?: string;
  /** Hermes' scratch directory. */
  scratchDir?: string;
  /** The host runs inside WSL. */
  wsl?: boolean;
  /** `HERMES_ENVIRONMENT_HINT` or `agent.environment_hint`. */
  embedderHint?: string;
  /** For a remote backend: the result of the probe, if the caller made one. */
  remoteProbe?: string;
  /** For a remote backend that is not in the built-in list: its description. */
  remoteDescription?: string;
}

function localHostHints(e: EnvironmentInfo): string {
  const lines = [`Host: ${e.host ?? "unknown"}`, `User home directory: ${e.homeDir ?? "unknown"}`];
  if (e.cwd !== undefined) lines.push(`Current working directory: ${e.cwd}`);
  if (e.scratchDir !== undefined) {
    lines.push(
      `Scratch directory: ${e.scratchDir} (TMPDIR points here; write temporary files ` +
        "and probes there, never under the system temp dir; entries idle for 24h are pruned)",
    );
  }
  return lines.join("\n");
}

function remoteBackendHint(backend: string, e: EnvironmentInfo): string {
  const lead =
    `Terminal backend: ${backend}. Your \`terminal\`, \`read_file\`, \`write_file\`, \`patch\`, and ` +
    "`search_files` tools all operate inside ";
  if (e.remoteProbe) {
    return (
      lead +
      `this ${backend} environment — NOT on the machine where Hermes itself is running. The host OS, ` +
      `home, and cwd of the Hermes process are irrelevant; only the following backend state matters:\n${e.remoteProbe}\n` +
      "  The sandbox's current user, $HOME, and working directory are not listed here; if you need them, " +
      "probe directly with a terminal call like `whoami && pwd`."
    );
  }
  const description =
    (BACKEND_FALLBACK_DESCRIPTIONS as Record<string, string>)[backend] ?? e.remoteDescription ?? `a ${backend} environment (likely Linux)`;
  return (
    lead +
    `${description} — NOT on the machine where Hermes itself runs. The backend probe didn't respond at ` +
    "prompt-build time, so the sandbox's OS, current user, $HOME, and working directory are unknown from here. " +
    "If you need them, probe directly with a terminal call like `uname -a && whoami && pwd`."
  );
}

/** Upstream `build_environment_hints`. Local backends get host, home and cwd. Remote backends get only their own state. */
export function buildEnvironmentHints(e: EnvironmentInfo): string {
  const backend = (e.backend ?? "local").trim().toLowerCase() || "local";
  const remote = REMOTE_BACKENDS.has(backend) || e.remoteDescription !== undefined;
  const hints: string[] = [remote ? remoteBackendHint(backend, e) : localHostHints(e)];
  if (e.wsl) hints.push(WSL_ENVIRONMENT_HINT);
  const embedder = (e.embedderHint ?? "").trim();
  return [...hints, embedder].filter((h) => h).join("\n\n");
}
