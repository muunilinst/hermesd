# Providers notes

Guide milestone 1 provider layer (guide 2.7, 6.3, 7.2, 7.4, 9.2.2). The package
converts the upstream `messages` table shape (`role`, `content`, `tool_calls`,
`tool_call_id`, and the replay columns) to the request body of four API modes,
and converts each answer back. It also holds the retry, fallback and key-rotation
rules, the error text, and a scripted model for each mode.

Upstream pin: a9ff9799. Upstream was read statically. No Python ran. Every
function has a comment with `file:function` of the upstream code it ports.

## What is here

| File | Content |
| --- | --- |
| `src/types.ts` | shared shapes: `Message`, `NormalizedResponse`, `ModelCallInput`, `RequestOptions` |
| `src/chat.ts` | chat_completions request, answer, and stream accumulator |
| `src/anthropic.ts` | anthropic_messages: message conversion, thinking policy, request, answer, stream |
| `src/codex.ts` | codex_responses: input items, request, answer, stream |
| `src/bedrock.ts` | bedrock_converse: message conversion, request, answer, event-stream decoder, signer interface |
| `src/errors.ts` | error classifier, user text, summaries |
| `src/retry.ts` | backoff, `Retry-After`, credential pool, the retry/fallback state machine |
| `src/router.ts` | `ProviderRouter`: runs the state machine over several targets |
| `src/client.ts` | `ModelClient` and the four clients |
| `src/scripted.ts` | `ScriptedModel` for each mode, plain and streamed |
| `src/sse.ts`, `src/sha256.ts` | server-sent events, errors, a synchronous SHA-256 |

### Upstream files ported

- Messages and requests: `agent/transports/chat_completions.py`,
  `agent/transports/anthropic.py`, `agent/transports/codex.py`,
  `agent/anthropic_message_convert.py`, `agent/anthropic_adapter.py`,
  `agent/anthropic_thinking_policy.py`, `agent/anthropic_endpoints.py`,
  `agent/codex_responses_adapter.py` (input items, tools, cache key),
  `agent/bedrock_adapter.py`, `agent/transports/types.py`.
- Streams: `auxiliary_client.py:_ChatStreamAccumulator`,
  `anthropic_adapter.py:_stream_final_message`,
  `bedrock_adapter.py:stream_converse_with_callbacks`, the Responses `response.completed` event.
- Errors and retries: `agent/error_classifier.py`, `agent/turn_failure_copy.py`,
  `agent/api_error_summary.py`, `agent/retry_utils.py`, `agent/credential_pool.py`,
  `agent/turn_recovery.py`, `agent/chat_completion_helpers.py`.

## The seam

`ModelClient` (`src/client.ts`) has `buildBody(input)` and `send(body, ctx)`.
`buildBody` is pure, so the loop can store the bytes in `pending_call.request`.
`send` takes the stored bytes and the call id (sent as `idempotency-key`).
It returns `{response, raw}` or throws:

- `ProviderHttpError` (has `status`, `body`, `headers`) for a non-2xx status.
- `StreamDroppedError` for a stream that ends or breaks before its terminal event.
- `MalformedResponseError` for a 2xx body that is not an answer.
- `AbortError` for an interrupt.
- Any other error is a transport failure.

session-actor has a structural type `LoopModelClient` (`src/loop.ts`) and an
optional `modelClient` in `SessionActorDeps`. It has no dependency on this
package. Without a client the loop speaks chat_completions as before, byte for byte.
With a client the loop does this:

| Outcome of `send` | Loop result |
| --- | --- |
| answer | the same as before |
| 429, 408, 5xx | `wait` (the wake obligation sends the same bytes again) |
| other status | the turn fails with `the model returned HTTP n` |
| `StreamDroppedError`, transport error | `wait`, the partial output is gone with the stack frame |
| `MalformedResponseError` | the turn fails with its message |
| abort | `again` |

The node simulator test is `packages/faults/src/loop/providers.test.ts`. It runs a
golden script in all four modes (plain and streamed), cuts a stream mid-token in
each mode, and checks that the request goes out twice with the same call id and
the same bytes, and that no partial assistant row exists.

`ProviderRouter` is the in-process form of upstream's retry loop (it sleeps, rotates
keys, falls back). The durable loop does not use it yet: the loop's own `wait` and
wake obligation replace the sleeps, and `pending_call.attempts` replaces the retry counter.
The router state (`RouterState`) is plain JSON and `decide()` is a pure function, so a
later change can keep the state in `pending_call.data` and call `decide()` from the loop.
See "Not done".

## Differences from upstream

### All modes

1. **Wire key order** follows the order of the keyword arguments in the upstream builders.
   The order on the wire in upstream is the one of the Python SDK, which is not visible
   statically. Golden transcripts must compare parsed JSON, not bytes.
2. **Compact JSON** (`JSON.stringify`) for all bodies. Python `json.dumps` default adds spaces.
3. **No SDK.** Upstream calls the OpenAI, Anthropic and boto3 SDKs. We build the HTTP request
   ourselves. SDK retries (the SDK retries 2 times on its own) are not ported, only the
   agent-level rules.
4. **Stream drop is an error that is thrown and retried**, not a partial result. Upstream
   in some paths returns the partial text and a `finish_reason` of `incomplete` or runs a
   salvage. The porting rule (guide 6.3) says to drop it and send the call again. The
   messages of the errors are upstream's.
5. **Streams are read to the end in one call.** There are no callbacks for reasoning or
   token deltas (`stream_callback`, `reasoning_callback`). The loop does not show deltas yet.
6. **Provider profiles are not ported** (`providers/*.py`: Nous, xAI, Gemini, Copilot,
   OpenCode, Kimi, and so on). The chat path is the generic one with a small set of
   host checks (OpenRouter, strict hosts, Gemini `extra_content`).
7. **Image handling** (eviction of old images, base64 size limits, vision routing) is not ported.
8. **Cache keys** use a synchronous SHA-256 written in TypeScript (`src/sha256.ts`)
   so that the builders stay synchronous. The result is the same as `hashlib.sha256`.

### chat_completions

- Only the generic path of `ChatCompletionsTransport.build_kwargs`. No per-provider
  `request_overrides`, no `fixed_temperature`, no ordering tricks for specific providers.
- `reasoning_content` and `reasoning_details` are replayed by host (`reasoningCarriers`).
- `developer` role swap for gpt-5 and codex models is ported.

### anthropic_messages

- No OAuth Claude-Code identity rewrite (the `system` prefix, tool-name prefix `mcp_`, and
  the rewrite of the answer). OAuth tokens are out of scope for the first provider layer.
- No `fast_mode`, no Bedrock or Vertex SDK clients (Bedrock goes through `bedrock_converse`).
- Thinking route is chosen by URL predicates (`thinkingRoute`) and not by the provider profile.
- `UNION_META_KEYS` (keys kept when a nullable union is flattened) is assumed to be
  `description`, `title`, `default`. The upstream constant was not read in full.
- Usage: cache read and write tokens are added back to `promptTokens`. The upstream
  mapping has more cases for third-party endpoints.
- `max_tokens` defaults to 64000 for a modern Claude model when the options do not set it.

### codex_responses

- No native compaction, no xAI or OpenCode quirks, no reserved tool aliases, no
  "leak recovery" for tool-call text in output, no per-model effort ladder.
- The xAI salvage path is skipped.
- Ids of tool calls are made deterministic (`deterministicCallId`, SHA-256 of name and arguments).

### bedrock_converse

- Upstream uses boto3 (`converse`, `converse_stream`). We use the REST API:
  `POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse[-stream]`.
  The model id is in the path, bytes are base64 strings, and the stream is AWS event-stream
  framing. The decoder (with CRC32) is written by hand in `src/bedrock.ts`.
- **Signing is injected** (`RequestSigner`). There is a bearer-token signer
  (`AWS_BEARER_TOKEN_BEDROCK` mode). SigV4 is not in this package; a host adapter must supply it.
- The stream decoder rejects a bad checksum as a dropped stream.

### Errors

- The classifier has these stages: HTTP status, error code, message, transport.
  It does not have the provider-specific stages (Nous, xAI, Gemini, MoA, OpenRouter metadata).
- A 400 with a content-policy phrase is classified as `content_policy_blocked`.
  The upstream order for this case was not captured, so this is an assumption.
- The provider label map (`providerLabel`) is a small table. Unknown names pass through.
- Billing (402) uses the default non-retryable text. Upstream has no separate text that was found.
- The transport stage uses JS error names (`TypeError` for `fetch failed`, `AbortError`) and
  not Python exception classes.
- 12 failures have exact-text tests in `src/errors.test.ts`. The templates are copied from
  `turn_failure_copy.py` and `api_error_summary.py`. `display_hermes_home` is fixed to `~/.hermes`.

### Retry, fallback, key rotation

Ported: `api_max_retries` 3; `jittered_backoff` (base 2 s, max 60 s, jitter ratio 0.5);
`Retry-After` wins and is capped at 600 s; live wait cap 60 s; the Z.AI overload schedule;
eager fallback for rate limit, billing and upstream rate limit; fallback after repeated timeout
and overload; one auth fallback; one primary recovery after the retries run out; the primary
cooldown `min(60 * 2^n, 14400)` s or the provider reset time; the credential pool with
`fill_first`, `round_robin`, `random`, `least_used`; exhaustion TTLs (401 300 s, 429 3600 s,
other 3600 s, sole key 60 s); one retry on the same key for a 429 before rotation.

Differences:

- **The retry count at which a timeout falls back** is checked after the increment, so the
  third failed try falls back (upstream: `retry_count >= 2` before the increment). The effect is the same.
- **"Primary transport recovery"** in upstream rebuilds the HTTP client. We have no client
  object to rebuild, so it is one more round of retries.
- **The pool is per target and in memory** (JSON state). Upstream saves it to `auth.json`
  and shares it between processes. Pool refresh of OAuth tokens is not ported.
- The `Retry-After` HTTP date form is parsed with `Date.parse`.
- Waits longer than 60 s are cut to 60 s for non-Z.AI providers (upstream: `LIVE_RETRY_WAIT_CAP_S`).
  A durable loop would instead store the wait in the wake obligation.

### ScriptedModel

- Same step fields as `session-actor/src/model/scripted.ts` (`reply`, `toolCalls`, `status`,
  `times`, `hold`, `drop`, `usage`). New fields: `retryAfter`, `errorMessage`, `dropAfter`,
  `dropTimes`, `dropMode`, `chunks`.
- One call id gets one step (idempotency). A re-send of a cut stream therefore gets the
  same step again, and `dropTimes` (default 1) says how many sends are cut.
- It checks the URL path against the mode (a wrong mode gives 404).
- It does not have the golden-transcript recorder of session-actor. It keeps `requests`
  (call id, path, headers, parsed body).

## Not done

- The loop does not use `ProviderRouter`. It has a small eager fallback of its own (`LoopFallback` in session-actor: 429 and 402 only; see `packages/golden/NOTES.md`). Fallback across modes needs the loop to rebuild the
  body from the stored messages when the target changes. Today `pending_call.request` holds
  the bytes of one target. The design is: store `RouterState` in `pending_call.data`, call
  `decide()` on a failure, and when the decision is `fallback` rebuild the request with the
  new target's `buildBody` and write it back in the same commit.
- No live test against a real provider. All tests use the scripted models.
- Prompt-cache layout (`cache_control` placement for Anthropic) follows upstream's
  "system and last 3 messages" rule only where it was read; other placements are not ported.
- `package-lock.json` is updated by `npm install --offline --package-lock-only`.

## Tests

- `src/roundtrip.test.ts`: request body and answer per mode, plain and streamed, with
  parallel tool calls and a tool error, replay of the stored assistant row, stream equals plain.
- `src/stream.test.ts`: dropped streams in every mode (closed and broken), upstream error
  text, delta merging.
- `src/router.test.ts`: backoff, `Retry-After`, pool strategies and TTLs, 429 fallback,
  key rotation, retry rules, fallback into every mode.
- `src/errors.test.ts`: 12 or more exact error texts, classifier rules.
- `packages/faults/src/loop/providers.test.ts`: the node simulator (both configurations):
  golden script in every mode, dropped stream re-drive, 429 in every mode.
