# 0009. The gateway is a stateless router; the gateway host stays in Python

- Status: Accepted; not built
- Date: 2026-11-11
- Source: porting guide rev 5.1, sections 6.7, 6.9, 5

## Context

Upstream runs one long-lived process with 26 chat adapters as plugins. Each message makes an
agent with the session history, and a 60 s tick runs cron and maintenance. Discord and Slack
socket mode hold a websocket open for hours. The adapters and their shared code are about
19,000 lines plus 8,000 to 9,000 per large platform.

An earlier draft called the Python side a "sidecar" that empties over time. The inventory
shows that is wrong: socket-shaped adapters, Python plugins and machine-bound tools need a
long-lived Linux process for reasons unrelated to language.

## Decision

- A **stateless Worker** receives webhooks, maps the chat ID to a session key, and forwards to the session actor.
- The **adapters stay in the gateway host**, unchanged. It is a permanent Linux process, not a temporary bridge. Start with the two or three adapters in use.
- **Cron** becomes a wake obligation on a scheduler actor; each job runs once per tick, keyed by job ID.
- **Deduplicate at the door:** the same platform message ID creates one `session_admissions` row and one turn, even if the webhook arrives twice. Upstream's `(principal, session, request)` uniqueness already enforces it.
- **Owed replies** are `delivery_obligations` rows, as upstream.
- For multi-tenancy, wrap many upstream gateway instances in one process; do not fork the adapter code.

## Consequences

- A chat-platform agent stays Python-bound at the edge until phase 5; a coding agent over an API does not need the gateway host for its turns after phase 3.
- A platform we do not serve can stay in Python forever at no cost.
- Which product this is (coding agent over an API, or personal agent on chat platforms) is an open question, and it decides how much of this matters.

## How we check it

Nothing in this repository implements the router yet. D3 (the same inbound message twice gives
one admission row and one turn) and D8 (a wake obligation fires twice for one cron job; the job
runs once) run on the Node host and cover the two rules the actor side owns. Phase 5 adds
adapter conformance tests that replay recorded platform payloads through both adapters.
