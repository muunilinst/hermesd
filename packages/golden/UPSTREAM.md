# Recording the upstream transcripts

A person does this, on a machine where upstream Hermes runs. The port side needs no upstream code. This file says how to get `transcripts/upstream/<name>.json` for each script in `scripts/`.

Status: this procedure was written from a static reading of upstream at the pin (`a9ff9799`, see `upstream/pin.json`). Nobody ran it. The config keys and the CLI flags below come from `cli-config.yaml.example`, `hermes_cli/config_defaults.py` and `hermes_cli/_parser.py` at the pin. If a key or flag has changed or is wrong, fix it here and tell the port team. Where a value is a guess, the text says so.

## What you need

- A checkout of upstream Hermes at the pinned commit, installed as its README says. Use it only as a program that you run. Do not copy code from it into this repository.
- Bun (the version in `.bun-version`), for the scripts in `scripted-server/`. They have no dependencies, so Node 22.18 or newer also runs them. `assemble.mjs` uses `node:sqlite`.
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
node $G/make-plugins.mjs $S "$HERMES_HOME/plugins"      # prints the config lines to add in step 2

# 2. Config: see "Config for each API mode" below. Write "$HERMES_HOME/config.yaml".

# 3. The scripted server. It prints one JSON line with its address, then waits.
node $G/server.mjs $S --port 8089 --log "$HERMES_HOME/requests.jsonl" &

# 4. The inputs. Print them, then give each one to Hermes, in order.
node $G/inputs.mjs $S
hermes chat -q "<first input>"
hermes chat -c -q "<second input>"                      # -c continues the session (check the flag at the pin)

# 5. Stop the server and build the transcript.
kill %1
node $G/assemble.mjs $S --log "$HERMES_HOME/requests.jsonl" --db "$HERMES_HOME/state.db" \
  --out packages/golden/transcripts/upstream/$NAME.json

# 6. Compare.
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
model:
  default: claude-sonnet-4-5
  provider: scripted
```

bedrock_converse: the server serves `POST /model/<id>/converse`. Point the Bedrock endpoint of Hermes at `http://127.0.0.1:8089` and turn streaming off. The server does not serve `converse-stream`. How Hermes takes an endpoint override for Bedrock is not known from the static reading. If there is none, record this scenario by hand with an `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` variable, or skip it and say so in the commit.

Fallback (`provider-fallback-429` only): put the primary model in `model` and add the fallback to the top-level list:

```
fallback_providers:
  - provider: custom
    model: fallback-model
    base_url: http://127.0.0.1:8089/v1
    api_key: x
```

The server picks the step list by the `model` field of the request. The primary list answers 429 every time. The fallback list answers the scripted reply.

Compaction (`compaction-50`, `compaction-85`): the context window must be 4000 tokens, so set it for the model (the key for a custom model context length is in `cli-config.yaml.example`; the name is not known here). Set `compression.threshold` to 0.5 for `compaction-50` and to 0.99 for `compaction-85`. For `compaction-85` the check at 85% is a gateway check, so send the inputs through the gateway or the API server and not through `hermes chat`.

Hook scripts: step 1 prints `plugins:` lines with `enabled` and `hook_callback_timeout`. Add them to the config. The `hook-time-budget` script needs `hook_callback_timeout: 0.2`.

## What the server does

```
node scripted-server/server.mjs <script.json> [--port 8089] [--log requests.jsonl]
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
| `interrupt-mid-call` | Send the first input. When the server logs the request, interrupt Hermes (Ctrl-C). Then `curl -X POST http://127.0.0.1:8089/__release/g1`. Send the second input. |
| `cancellation-during-tool` | Send the first input. When the tool starts (`sleep 60`), interrupt Hermes. Send the second input. |
| `persistence-failure-before-tool` | After the server logs request 0, make `state.db` (and its `-wal` and `-shm` files) unwritable, for example with `chmod a-w`, before the tool runs. Check that the tool did not run. The way upstream reports this is not known from the static reading. |
| `clarify-sequential` | Hermes asks "Which file?". Type `a.txt` as the second input. |
| `compaction-85` | Use the gateway or the API server. |
| `format-bedrock-converse` | See the Bedrock note above. |

All other scripts run without a person once the config is in place.

Commands in the scripts are plain: `echo hello`, `echo one`, `echo two`, `ls nope`, `sleep 60`. Hermes runs them for real. The port runs a simulated executor that returns the output given in `commands`. For `sleep 60` the port holds the command until the user stops the turn.

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

## What to commit

The files in `transcripts/upstream/`. Do not commit `HERMES_HOME`. Once an upstream file exists, `bun run check` compares it with the port transcript. A script with no upstream file shows as skipped, with the reason.
