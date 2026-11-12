# Golden transcripts

Guide 7.2: a scripted model gives fixed answers. A runner records every request that the loop sends to the model, in order. It also records the `messages` and `session_admissions` rows that the run wrote. The same script is played by upstream Hermes, and the two records are compared. A difference is a port bug or an upstream change. The diff tells you which.

This package is the port side, plus the tools for the upstream side.

## What is here

| Path | Content |
| --- | --- |
| `scripts/<name>.json` | One scenario: the scripted model answers, the user inputs, the config, the expected outcome. 20 files. |
| `transcripts/port/<name>.json` | The record of the port for that script. Committed. Deterministic. |
| `transcripts/upstream/<name>.json` | The record of upstream Hermes for that script. Made by a person (see `UPSTREAM.md`). Empty until then. |
| `src/runner.ts` | Plays a script through the session actor on the Node simulator, in both modes (`durable-objects` and `rivet`). |
| `src/compare.ts` | Compares a port record with an upstream record. Names the request index and the field. |
| `src/cli.ts` | `list`, `record`, `check`, `compare`. |
| `scripted-server/` | Standalone Node scripts with no dependencies, for the upstream side: the scripted model server, an input printer, a Python plugin writer, and a record assembler. |
| `UPSTREAM.md` | How a person records the upstream transcripts. |
| `NOTES.md` | Decisions, port bugs that the scripts found, and what is not done. |

## Commands

Run them from the repository root.

```
bun packages/golden/src/cli.ts list                      # the 20 names
bun packages/golden/src/cli.ts record [name...]          # play, and write transcripts/port/<name>.json
bun packages/golden/src/cli.ts check [name...]           # play, and fail if a committed file differs
bun packages/golden/src/cli.ts compare [name...]         # diff port and upstream records (--ignore <path>, --strict)
```

`bun run check` runs the tests of this package. They always play every script again and compare the result with the committed port transcript. If you change the loop on purpose, run `record` and read the diff of the transcripts before you commit it.

## The record

The format is `hermesd-golden/1` from `packages/session-actor/src/model/recorder.ts`:

- `requests`: for each request to the model, in order: `index`, `method`, `path`, and the parsed JSON `body`. A retry is a request.
- `rows.messages`: the `messages` rows: `role`, `content`, `tool_calls`, `tool_call_id`, `tool_name`, `finish_reason`, `active`, `compacted`.
- `rows.admissions`: the `session_admissions` rows: `status`, the input text, `outcome`.

Left out on purpose: timestamps, row ids, message uids, call ids, the idempotency key. They are random or clock-based by design. Request bodies are compared as parsed JSON, so the order of keys does not count (the providers NOTES say why: the wire order of upstream follows the Python SDK and cannot be read statically). Dates written as `YYYY-MM-DD` are treated as equal, because the compaction summary prompt has the date of the day.

## The 20 scripts

| Name | Purpose | Guide behavior |
| --- | --- | --- |
| `cancellation-during-tool` | The user stops the turn while a tool command runs; the command is cancelled and the next input works. | cancellation at each point of a turn (during a tool) |
| `clarify-sequential` | A clarify call forces the calls of its answer to run one at a time; the user answer is the next input. | clarify forcing sequential |
| `compaction-50` | The history passes 50% of the context window: a summary call, then the real call in the child session. | compaction at 50% |
| `compaction-85` | The history passes 85% of the window while the threshold is 99%: only the gateway hygiene check compresses. | compaction at 85% |
| `dropped-stream-mid-token` | A streamed answer is cut in the middle of a token; the partial text is dropped and the same request is sent again. | streaming, dropped stream mid-token |
| `format-anthropic-messages` | A tool call and a final answer in the anthropic_messages wire format. | anthropic_messages format |
| `format-bedrock-converse` | A tool call and a final answer in the bedrock_converse wire format. | bedrock_converse format |
| `format-chat-completions` | A tool call and a final answer in the chat_completions wire format (the baseline). | chat_completions format |
| `format-codex-responses` | A tool call and a final answer in the codex_responses wire format. | codex_responses format |
| `hook-blocks-tool` | A pre_tool_call hook returns a block; the tool does not run and the model gets the message as the result. | a hook that blocks a tool |
| `hook-crashes` | A pre_tool_call hook raises; the policy hook fails closed, so the tool does not run. | a hook that crashes |
| `hook-time-budget` | A pre_tool_call hook never returns; at the time budget it is cut and the tool is blocked (fail closed). | a hook that exceeds its time budget |
| `interrupt-mid-call` | The user stops the turn while the model request is in flight; the partial answer is dropped and the next input works. | interrupt mid-call |
| `one-tool-call` | The model calls the terminal tool once and then answers from the result. | one tool call |
| `parallel-tools` | Two terminal calls in one answer run together; results go back in call order. | parallel tools |
| `persistence-failure-before-tool` | The write of the tool-call turn fails; the turn ends with an error and no tool runs. | a persistence failure before tool execution |
| `plain-reply` | One user message, one plain model answer, no tools. | plain reply |
| `provider-fallback-429` | The primary model answers 429; the loop switches to the fallback model at once and sends the same history there. | provider fallback on a 429 |
| `three-plugins-hook-order` | Three plugins on pre_tool_call, loaded out of order: the first block in directory order wins. | hook ordering with 3 plugins on one hook |
| `tool-error-text` | Three failing calls in one answer: a command that exits 2, an unknown tool, and a terminal call with no command. | error behavior, tool error text |

Sixteen scripts follow the list in guide 7.2: plain reply, one tool call, parallel tools, clarify forcing sequential, compaction at 50% and 85%, interrupt mid-call, provider fallback on a 429, the three non-chat formats and the chat baseline, a hook that blocks, a hook that crashes, a hook that exceeds its time budget, and a persistence failure before tool execution. Four scripts follow guide 7.4, which names five behaviors outside the contract surfaces: dropped stream (streaming), cancellation during a tool, hook ordering with 3 plugins, and tool error text. The fifth behavior, provider authentication and key rotation, has no script here: it is a test of `packages/providers`.

## Script format

A script is JSON. The type is `Script` in `src/script.ts`.

- `steps`: the model answers, in order. The fields are those of the `ScriptedModel` in `packages/providers/src/scripted.ts`: `reply`, `toolCalls`, `status`, `times`, `hold`, `drop`, `dropAfter`, `dropMode`, `chunks`.
- `mode`, `stream`, `model`: the API mode of the primary model.
- `fallback`: a second model (`mode`, `model`, `steps`) for the fallback scenario.
- `commands`: the result of each shell command that the model writes. The port runs a simulated executor. Upstream runs the real command, so the command strings must be ones that give the same output (`echo hello`).
- `hooks`: plugins with a `pre_tool_call` callback that blocks, throws, hangs or does nothing. The port loads them through the real plugin host (`@hermesd/plugin-host`) from JS files. Upstream gets Python plugins from `scripted-server/make-plugins.mjs`.
- `inputs`: the user texts. `{lorem: n}` makes filler text of `n` characters. `interrupt` stops the turn while a model request or a tool command is in flight.
- `fault`: a fault for the port run (`persistence_failure_after_model`).
- `expect`: replies, number of requests, number of tool runs, hook log. The tests check them.
- `upstream`: how to record the scenario upstream (`procedure`, `manual`) and the field paths to ignore in the comparison.
