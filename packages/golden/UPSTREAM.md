# Recording the upstream transcripts

A person does this, on a machine where upstream Hermes runs. The port side needs no upstream code. This file says how to get `transcripts/upstream/<name>.json` for each script in `scripts/`.

Status: first written from a static reading of upstream at the pin (`a9ff9799`, see `upstream/pin.json`), then run on 2026-11-12 against that pin on Ubuntu 26.04 (OrbStack VM, aarch64) and corrected where it was wrong. The section "What changed after the first run" lists each correction. The drivers that were used are in `bench/upstream/work/` of the run worktree (`record.py`, `clarify_pty.py`, `persist_fail.py`); they follow this file.

## What you need

- A checkout of upstream Hermes at the pinned commit. Use it only as a program that you run. Do not copy code from it into this repository. The README installer (`install.sh`) sets up a managed install; a source checkout works too:

  ```
  uv python install 3.14.10      # its SQLite is 3.53.1; see below
  UV_PROJECT_ENVIRONMENT=~/hvenv uv sync --frozen --python "$(uv python find 3.14.10)" \
    --extra anthropic --extra bedrock --extra messaging
  export PATH=~/hvenv/bin:$PATH
  ```

  The extras are needed: `anthropic` for `anthropic_messages` and Bedrock (without it the auto-started gateway exits mid-turn with "restart Hermes to activate it" and the turn ends "Gateway disconnected; turn outcome is unknown"), `bedrock` for boto3, `messaging` for aiohttp (the API server platform). Use a Python whose SQLite is 3.51.3 or newer: with an older one (the Ubuntu 26.04 system Python 3.14.4 has 3.46.1) Hermes turns WAL off and uses `journal_mode=DELETE`, which changes what it writes.
- Bun (the version in `.bun-version`), for the scripts in `scripted-server/`. Bun 1.4.2 runs all four, `assemble.mjs` (`node:sqlite`) included, so Node is not needed. Every command in this file uses `bun`.
- This repository.

## The idea

Hermes is told that its model endpoint is `http://127.0.0.1:8089`. A small server (`scripted-server/server.mjs`) listens there. It reads the same script file as the port runner and gives the scripted answers in the wire format of the API mode. It writes every request it gets to a log, one JSON line each. Hermes then writes its `messages` and `session_admissions` rows to its own `state.db`. `assemble.mjs` joins the request log and the rows into one file in the shared format. The comparator diffs that file against the port transcript.

## One scenario, step by step

Use a new `HERMES_HOME` for each scenario. Then `state.db` holds the rows of that scenario only.

```
NAME=one-tool-call                                   # a file name in packages/golden/scripts/
S=packages/golden/scripts/$NAME.json
G=packages/golden/scripted-server
export HERMES_HOME=$(mktemp -d)

# 1. Hook plugins (only the four scripts that have "hooks"; for the others this writes nothing).
bun $G/make-plugins.mjs $S "$HERMES_HOME/plugins"      # prints the config lines to add in step 2

# 2. Config: see "Config for each API mode" below. Write "$HERMES_HOME/config.yaml".
#    Every config needs these two top-level keys as well:
#      _config_version: 52                   # without it Hermes logs "config predates version 12 ... can no longer be auto-migrated"
#      auxiliary: {title_generation: {enabled: false}}   # else a title request (plus 2 retries) is sent to the scripted server and takes its steps

# 3. The scripted server. It prints one JSON line with its address, then waits.
bun $G/server.mjs $S --port 8089 --log "$HERMES_HOME/requests.jsonl" &

# 4. The inputs. Print them, then give each one to Hermes, in order.
bun $G/inputs.mjs $S
hermes chat -q "<first input>"                          # on a non-TTY -q answers and exits (--oneshot is implied)
hermes chat -c -q "<second input>"                      # -c continues the most recent session (checked at the pin)

# 5. Stop the server and the gateway, and build the transcript.
kill %1
hermes gateway stop                                     # `hermes chat` auto-starts a gateway for this HERMES_HOME (`gateway run --idle-exit`, 600 s idle exit); a stale one makes the next home's gateway start "beside it" and can break the next scenario
bun $G/assemble.mjs $S --log "$HERMES_HOME/requests.jsonl" --db "$HERMES_HOME/state.db" \
  --out packages/golden/transcripts/upstream/$NAME.json

# 6. Compare (the policy of "Expected differences" below; add --strict for exact parity).
bun packages/golden/src/cli.ts compare $NAME
```

Keep `HERMES_HOME` until you have read the diff. The comparison does not need it, but a difference may need a look at `state.db` and at the Hermes logs.

## Config for each API mode

The primary model name is the `model` field of the script. If the script has none, use the default of the mode: `gpt-4o` (chat_completions), `claude-sonnet-4-5` (anthropic_messages), `gpt-5-codex` (codex_responses), `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (bedrock_converse). The key can be any text.

chat_completions (an OpenAI-compatible endpoint, the example in `cli-config.yaml.example`):

```
model:
  default: gpt-4o
  provider: custom
  base_url: http://127.0.0.1:8089/v1
  api_key: x
  streaming: false          # true for the one script that has "stream": true
```

anthropic_messages and codex_responses: use a named provider with the matching `api_mode`, as in the `providers:` example of `cli-config.yaml.example`:

```
providers:
  scripted:
    base_url: http://127.0.0.1:8089/v1        # for anthropic_messages use http://127.0.0.1:8089 (the SDK adds /v1/messages)
    api_mode: anthropic_messages              # or codex_responses
    model: claude-sonnet-4-5                  # or gpt-5-codex
    api_key: x
model:
  default: claude-sonnet-4-5
  provider: scripted
  streaming: false                            # without it both modes stream
```

codex_responses streams even with `streaming: false` (every request has `"stream": true`). That is upstream behavior, not a config error: the transcript shows it as a difference.

bedrock_converse: the server serves `POST /model/<id>/converse`. botocore takes the endpoint from the environment. Without `AWS_BEARER_TOKEN_BEDROCK`, Hermes sends a Claude model id (`us.anthropic.*`) through the AnthropicBedrock SDK (`anthropic_messages`) to the real AWS endpoint, and the turn fails with HTTP 403. With the token it stays on Converse. Set `context_length`, or Hermes first sends two context probes (`"data data ..."`, `maxTokens: 8`) that take steps of the script.

```
# environment of `hermes chat`
AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://127.0.0.1:8089
AWS_BEARER_TOKEN_BEDROCK=x
AWS_REGION=us-east-1

# config.yaml
model:
  default: us.anthropic.claude-sonnet-4-5-20250929-v1:0
  provider: bedrock
  api_mode: bedrock_converse
  streaming: false
  context_length: 200000
```

Fallback (`provider-fallback-429` only): put the primary model in `model` and add the fallback to the top-level list:

```
fallback_providers:
  - provider: custom
    model: fallback-model
    base_url: http://127.0.0.1:8089/v1
    api_key: x
```

The server picks the step list by the `model` field of the request. The primary list answers 429 every time. The fallback list answers the scripted reply.

Compaction (`compaction-50`, `compaction-85`): these cannot be recorded at the pin. The key is `model.context_length`, but Hermes refuses a window under 64,000 tokens (`MINIMUM_CONTEXT_LENGTH` in `agent/model_metadata.py`; the check in `agent/agent_init.py` lets only `provider: lmstudio` go below it). With `context_length: 4000` every turn ends with "Your local server is serving a 4,000-token window. Start it with at least 64K context" and no request reaches the server. Even below the floor, the system prompt and tools of Hermes are about 3,900 tokens, so the first request alone would pass 50% of a 4,000-token window. To record compaction, the scripts need a window of at least 64K and inputs scaled to it; that is a change to the scripts, so it is not done here. `compression.threshold` is the right key.

Hook scripts: step 1 prints `plugins:` lines with `enabled` and `hook_callback_timeout`. Add them to the config. The `hook-time-budget` script needs `hook_callback_timeout: 0.2`. This works as written (checked at the pin).

## What the server does

```
bun scripted-server/server.mjs <script.json> [--port 8089] [--log requests.jsonl]
```

- `POST .../chat/completions`, `.../messages`, `.../responses`, `.../model/<id>/converse`: it logs the request and answers with the next step. A body with `"stream": true` gets a server-sent-event stream (not for Bedrock).
- A step with `status` answers with that status. With `times: n` it fails n times and then answers normally. Without `times` it fails every time.
- A step with `hold: "<name>"` waits until `POST /__release/<name>`.
- A streamed step with `dropAfter: k` sends k frames and then cuts the connection, once (`dropTimes` sets how often).
- `GET /__log` returns the requests so far.
- The server is tested against the provider clients of the port (`src/server.test.ts`), so its answers parse in all four modes. It has not been tested against upstream Hermes.

## Which scenarios need a person

`manual: true` in a script means that a driver cannot do it alone. The `procedure` field of the script says what to do. Summary:

| Script | What the person does |
| --- | --- |
| `interrupt-mid-call` | Send the first input. When the server logs the request, interrupt Hermes (Ctrl-C). Then `curl -X POST http://127.0.0.1:8089/__release/g1`. Send the second input. A SIGINT to `hermes chat -q` on a non-TTY does the same as Ctrl-C (checked). |
| `cancellation-during-tool` | Send the first input. When the tool starts (`sleep 60`, visible in `pgrep -f "sleep 60"`), interrupt Hermes (SIGINT works). Send the second input. |
| `persistence-failure-before-tool` | `chmod a-w` does not work: the gateway already has `state.db` open, so its writes go on, the tool runs and the turn completes. What was used instead: `HERMES_HOME` on a 400 MB tmpfs, filled to 100% (`dd if=/dev/zero of=$HERMES_HOME/filler`) after request 0. Request 0 has no gap before the tool call, so a copy of the script with `"hold": "p0"` on step 0 was served and released after the fault. Even then the tool ran: SQLite wrote the tool turn into WAL space it already had. Only the admission settlement failed ("database or disk is full", retried forever); the client never got a reply and was killed after 240 s; the admission stays `unknown`. |
| `clarify-sequential` | Needs a TTY (a pty works). Hermes shows a menu ("Which file?", `1. a.txt (Recommended)`, `2. b.txt`, `3. Other`). Press Enter to lock `a.txt`. Do not type `a.txt` first: the text stays in the composer and is sent later as a new turn. The answer is part of the first turn, not a second input, so upstream has one admission. |
| `compaction-85` | Cannot be recorded at the pin; see "Compaction" above. |
| `format-bedrock-converse` | No longer manual; see the Bedrock note above. |

All other scripts run without a person once the config is in place.

Commands in the scripts are plain: `echo hello`, `echo one`, `echo two`, `ls nope`, `sleep 60`. Hermes runs them for real. The port runs a simulated executor that returns the output given in `commands`. For `sleep 60` the port holds the command until the user stops the turn.

## Expected differences (the policy)

Recorded upstream transcripts differ from the port in every script today. These differences are listed in `transcripts/upstream/expected-differences.json`: for each script the number of differences, the sorted field paths, and a sha256 digest of the full difference list (fields and both values) in canonical form: object keys sorted at every depth and the records sorted, so the order of keys or of traversal does not change it. `src/baseline.ts` applies it, and both `golden.test.ts` and the verification command use it.

- `bun packages/golden/src/cli.ts compare [name...]` (what `verify.ts run golden` runs) applies the policy. For every script it prints the field-by-field differences (as in "Reading a difference") and marks the script `[expected]` (its differences are exactly its baseline entry) or `[UNEXPECTED]`; the exit code follows the policy, not the presence of differences. Script names and `--ignore <path>` work in every mode: `--ignore` only hides fields from the printed list, the policy still judges the full list (with the script's own ignore list). It fails when an upstream fixture is invalid (wrong `script`, `side` or `format`, or no requests, `messages` rows or `admissions` rows), when a script without an entry differs, when a script with an entry has a difference that vanished (entry for a script that now agrees), a new difference, or a changed value, and when an entry names a script with no upstream transcript.
- `compare --strict` is exact parity: no ignore list of the script, and the baseline file is not read at all (a missing or malformed one cannot block the diagnosis); any difference exits 1. Names and `--ignore` apply. Use it to see everything, and as the goal once the differences are triaged.
- After you have read a diff and decided it is expected (see below), run `bun packages/golden/src/cli.ts baseline [name...]` to rewrite the entries, and commit the file with the reason.
- Do not accept a changed digest without reading the new diff. Fixing a difference makes its entry stale: the policy fails until the entry is removed (`baseline` does that).

## Reading a difference

`bun packages/golden/src/cli.ts compare <name>` prints one block for each difference:

```
request 1: requests[1].body.messages[2].content
  port:     "{\"output\":\"hello\\n\",\"exit_code\":0,\"error\":null}"
  upstream: "{\"output\": \"hello\", \"exit_code\": 0, \"error\": null}"
```

It names the request index and the field. For rows it says `messages row 3` or `admissions row 0`. Add `--ignore <path>` (more than once if needed) to hide a field while you work on another. A path matches itself and everything under it. `[*]` stands for any index. The tokens `@system` and `@tools` hide the system prompt and the tool list in any API mode.

Each script already ignores `@system` and `@tools` (and `prompt_cache_key` for Codex), because the port loop runs with a short test prompt and three tools today, not the prompt and tools of Hermes. When the prompt builder and the tool registry are in the loop, remove these from the `ignore` lists in the scripts, and the comparison becomes strict. To see everything now, run `compare --strict`: it does not use the ignore list of the script.

For each difference decide one of:

1. A port bug. Fix the port. Record the fix in `NOTES.md`. Run `record`, read the diff of the port transcript, and commit.
2. An upstream change since the pin, or something that was not in the pin. Move the pin (see `contracts/README.md`) and run the contract checks again.
3. A difference of the stand-in, not of the behavior: for example the executor of the port is simulated, or the port writes compact JSON where Python writes `", "` and `": "`. Add the field to the `ignore` list of that script with a one-line reason in `NOTES.md`. Do not add a field to hide a real difference.

Known differences to expect on the first recording:

- The tool result JSON. Python `json.dumps` writes a space after `:` and `,`. The port writes compact JSON for the terminal result. The hook block result already uses the Python form.
- The output of `terminal`: upstream may strip the trailing newline and add other keys.
- `tool_calls` in the rows: upstream may store more keys than `id`, `type` and `function`.
- `session_admissions`: `hermes chat` may not write this table. If it is empty, compare with `--ignore rows.admissions` and say so in the commit, or use the gateway.
- Bedrock paths: the model id is percent-encoded in the path (`%3A` for the colon). A boto3 client does the same.

## What changed after the first run

The first run (2026-11-12, pin `a9ff9799`) found these errors in the static reading:

1. Install: the `anthropic`, `bedrock` and `messaging` extras are needed, and a Python whose SQLite is 3.51.3 or newer (else no WAL).
2. Every config needs `_config_version: 52` and `auxiliary.title_generation.enabled: false` (title requests took script steps: `plain-reply` got 4 requests instead of 1).
3. `hermes chat` auto-starts a gateway per `HERMES_HOME`; stop it with `hermes gateway stop` after each scenario.
4. `-c` is right. `-q` on a non-TTY implies `--oneshot`.
5. Named providers need `api_key` and `model.streaming: false`. codex_responses streams anyway.
6. Bedrock: the endpoint override is `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, plus `AWS_BEARER_TOKEN_BEDROCK` to stay on Converse and `model.context_length` to skip the context probe. The scenario is no longer manual.
7. Compaction: `model.context_length` is the key, but the 64K floor makes both compaction scripts impossible to record as written.
8. `persistence-failure-before-tool`: `chmod a-w` has no effect; see the table.
9. `clarify-sequential`: the answer is a menu choice inside the first turn.
10. Bun runs `assemble.mjs`; Node is not needed.

## What to commit

The files in `transcripts/upstream/`. Do not commit `HERMES_HOME`. Once an upstream file exists, `bun run check` compares it with the port transcript. A script with no upstream file shows as skipped, with the reason.
