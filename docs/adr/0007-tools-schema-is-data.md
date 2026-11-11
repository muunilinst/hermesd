# 0007. A tool schema is data; the handler is the only code

- Status: Accepted
- Date: 2026-11-11
- Source: porting guide rev 5.1, sections 2.5, 2.7.1, 6.5

## Context

Upstream registers a tool as a schema (an OpenAI function definition), a handler, and an
availability check. The model sees only the schema. There are 70 to 85 tools in about 28
toolsets and about 110,000 lines of top-level handler code. Of that, roughly 45,000 lines need
a machine (subprocess, PTY, kernels, browser, stdio MCP), 15,000 need the user's workspace,
25,000 are HTTP wrappers that run anywhere, and 25,000 are agent-internal.

## Decision

Load every upstream tool schema as JSON and emit it unchanged, byte for byte. Mark each tool
supported or not yet; the model sees only supported tools. Port handlers one at a time, in
order of use: `terminal`, `read_file`, `patch`, `web_search`, `memory`, `todo`, `clarify`.

Three handlers change shape:

- **terminal:** no subprocess. `prepare` and `start` an operation on the executor and wait for the result event ([0004](0004-executor-contract-unknown-is-an-answer.md)). Upstream already has remote backends, so this is a new backend, not a new idea.
- **browser:** no Chromium in the actor. Call the browser on the executor machine with the same schema.
- **MCP:** HTTP and SSE from the actor; a stdio server runs on the machine and is exposed over HTTP.

Keep `pre_tool_call` before dispatch, `post_tool_call` after, and the dangerous-command
approval gate with its allowlist. File writes go through the executor too.

Milestone 1 supports three tools only: `clarify`, `todo`, `terminal`.

## Consequences

- The model cannot tell the port from upstream by its tools.
- A schema built at run time upstream cannot be extracted statically. The extractor lists those under `non_literal`; they need another method.
- An approval is history, not authorization: a step that acts on one checks permission again when it runs.
- 55 to 60 percent of upstream's own code is bound to a machine or to Python by nature. Porting a handler changes its language, not where it must run.

## How we check it

`contracts/upstream/tool-schemas.json` and the schema test in `packages/contracts`.
`packages/session-actor/src/tools.test.ts` ("tool schemas are data", todo, clarify, terminal).
Golden scripts `one-tool-call`, `parallel-tools`, `clarify-sequential`, `tool-error-text`.
Later phases add a per-tool differential test that replays recorded HTTP fixtures through both
handlers and compares the JSON string returned.
