/**
 * Tool schemas that the contract extractor could not read as literals.
 *
 * Rule 3 of the guide says the schema is data and must not change. For a tool
 * whose upstream schema is not in `contracts/upstream/tool-schemas.json`, this
 * file holds a stand-in. Each stand-in is marked `provisional: true` and the
 * model sees it like any other schema. The test `tools.test.ts` lists them, so
 * a provisional schema cannot go unnoticed.
 */

export interface ProvisionalSchema {
  provisional: true;
  /** The upstream file and name that must replace this stand-in. */
  source: string;
  /** Why the extractor could not read it. */
  reason: string;
  schema: Record<string, unknown>;
}

// TODO(upstream tools/terminal_tool.py, TERMINAL_SCHEMA): replace this stand-in with the real schema.
// The extractor lists it under `non_literal` because the timeout text is built
// at import time from environment variables
// (`_safe_parse_import_env('TERMINAL_MAX_FOREGROUND_TIMEOUT', 600, int, 'integer')`).
// Extend contracts/extract/run.py to evaluate that call, or record the schema from a live run.
export const TERMINAL_SCHEMA: ProvisionalSchema = {
  provisional: true,
  source: "tools/terminal_tool.py: TERMINAL_SCHEMA",
  reason: "non-literal: the description is built from environment variables at import time",
  schema: {
    name: "terminal",
    description:
      "Execute shell commands in the workspace. The filesystem persists between calls. " +
      "Pass the command in `command`. Use `workdir` for a working directory and `timeout` for a limit in seconds.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute." },
        background: { type: "boolean", description: "Run the command in the background.", default: false },
        timeout: { type: "integer", description: "Maximum time in seconds.", minimum: 1 },
        workdir: { type: "string", description: "Working directory for this command." },
        pty: { type: "boolean", description: "Run with a pseudo-terminal.", default: false },
      },
      required: ["command"],
    },
  },
};
