# @hermesd/prompt

The port of the system prompt builder and the context compressor of upstream
Hermes (pinned at `a9ff9799`). The package reads no files and makes no model
call. The caller gives it the data, and it gives back text and plans.

## Upstream files ported

| Port | Upstream |
| --- | --- |
| `src/builder.ts` | `agent/system_prompt.py::build_system_prompt_parts` (tiers: stable, context, volatile) and the guidance choice in `agent/prompt_builder.py` |
| `src/upstream-text.ts` (generated) | the text constants of `agent/prompt_builder.py` |
| `src/context-files.ts` | `agent/prompt_builder.py` context file loading, `# Project Context` wrapper, truncation |
| `src/threat.ts` | `tools/threat_patterns.py::scan_for_threats` (scopes `all` and `context`) |
| `src/timestamp.ts`, `src/environment.ts` | the date line and the runtime environment block of `build_system_prompt_parts` |
| `src/compress/tokens.ts` | `agent/model_metadata.py::estimate_tokens_rough` and the message estimators |
| `src/compress/threshold.ts` | `ContextCompressor` threshold, tail budget and summary budget; `gateway/run_turn_hygiene.py` (85% or 5000 messages) |
| `src/compress/window.ts` | `_find_tail_cut_by_tokens`, `_align_boundary_forward/backward`, head protection |
| `src/compress/summary.ts` | `_serialize_for_summary`, `_generate_summary` prompt build, `_with_summary_prefix`, the fallback summary |
| `src/compress/assemble.ts` | `_summary_placement`, `_merge_summary_into_tail_row`, `_assemble_compressed`, `_sanitize_tool_pairs` |
| `src/compress/upstream-text.ts` (generated) | the summary prompt text, `SUMMARY_PREFIX`, the end marker and the other strings of `agent/context_compressor.py` |

Fixtures: `fixtures/upstream/*.txt` and `surfaces.json` are copies of
`tests/fixtures/prompt_surface/` (pinned upstream by
`tests/ci/test_prompt_surface.py`). `src/builder.test.ts` asserts that the
builder output equals eight of these surfaces byte for byte (cli with the
claude, gpt, gemini and hermes models; cron; desktop; telegram; discord).
Telegram and Discord get their platform hint from a plugin upstream, so the
test passes the hint from the fixture as input.

## Generated text

`src/upstream-text.ts` and `src/compress/upstream-text.ts` come from
`scripts/`. The scripts read the upstream source with the Python `ast`
module. They never import or run upstream code.

    export HERMES_UPSTREAM=<path to the upstream checkout>
    cd packages/prompt/scripts
    python3 -I extract.py consts.json
    python3 -I templ.py templ.ts
    python3 -I build.py ../src

(`consts.json` and `templ.ts` are intermediate files. Do not commit them.)

## Token counting

Upstream `estimate_tokens_rough` uses no tokenizer library. ASCII text counts
(len + 3) // 4. Other text counts each CJK character as 1 and the rest as
ceil(UTF-8 bytes / 4). The port does the same, so no fallback was needed.
Messages are counted from their JSON wire form (upstream uses the Python
`str(dict)` form; the numbers differ a little).

## Threshold facts (kept from upstream)

- Defaults: threshold 0.5, protect first 3, protect last 20.
- A window under 512K tokens is raised to 75%, and the trigger has a 64K
  floor, capped at 85% where the floor binds. So 50% is exact only for
  windows of 512K tokens or more. A test with a small window lowers
  `minimumContextLength` and `smallContextWindowLimit` in the config.
- Tail budget: 2.5% of the window, between 10K and 25K tokens, at most half
  the trigger and at most 20% of the window. The soft ceiling is 1.5 times it.
- The head decays to 0 once a summary exists.
- Anti-thrash: the verdict on a compaction is judged on the next measurement.
  At or above the threshold is one strike; below resets to 0; two strikes
  block compression. The strike count is `sessions.compression_ineffective_count`.
  Hygiene (85%) ignores the strikes.

## How the loop uses it (packages/session-actor)

- The check runs when the loop plans a model call. If compression is due, the
  planned call is replaced by the summary call: a `pending_call` with
  `data.purpose = "compression"`, call id `<turn>:k<n>`, and its own wake
  obligation (porting rule 1). A retry reuses the call id.
- One commit settles the call, writes the child session (head, summary,
  tail), writes `compaction_link` as `started`, and makes the child the
  current session. A second commit (`finishCompaction`) turns the parent rows
  inactive. A crash between them is repaired on adopt (D7). The guard on the
  pending row means a summary is used once.
- If the summary call fails hard, returns no text, or runs out of retries, the
  static fallback summary is used and the turn goes on.
- Hygiene is checked on the history before the first step of a turn.
- A crash after the compaction step and before the next step ends the turn as
  `unknown` (the runtime rule for a lost owner between steps). The compaction
  is not repeated.
- Port limit: one turn makes at most 3 summary calls.
- The old `LoopConfig.compress` hook (flat 50%) still works and turns the
  built-in compressor off.

## Not ported (and what the port emits)

Prompt builder. Each item below is emitted as upstream emits it when the
feature is off (nothing, or the plain default), unless the caller passes the
text as input.

- Skills index: input (`PromptInput`), not read from disk.
- Memory store and memory blocks: input.
- Kanban guidance, coding context, bot mode, plugin sections, the env probe
  line, the Windows bash hint, Bot Screen, the remote probe, the hud note:
  off.
- The cli-code surface is not tested because the coding context is absent.
- The timezone abbreviation comes from `Intl`. The session id stamp is read as
  UTC.

Compression:

- Not ported: the tool-result pre-prune, lean-mode extras (verbatim user
  messages, anchor index, session log), redaction, the memory-provider
  section, skill-prune markers, provenance checks, the multi-user anchor, the
  handoff rehydration scan, media rules, thinking fields, the anti-thrash
  cooldowns, feasibility skip and fallback streak, prepared compaction, the
  summary `max_tokens`, and the stripping of orphan tool calls.
- Simplified: the think-block strip; the static fallback summary (no file or
  blocker extraction beyond the basics).
- The window is planned over the stored rows plus the rows that the same step
  writes.
- The tail rows are cloned into the child, so the parent tail rows also become
  inactive.
