---
name: verify-plugins
description: Verify the hermesd plugin host, which loads plugin.yaml manifests, dispatches hooks with upstream Hermes semantics, and routes each call site by its python, shadow or ts flag. Use after a change to packages/plugin-host or to how the session loop calls hooks such as pre_tool_call.
---

# Verify the plugin host (guide 6.6, 3.5, 9.1)

Shared launch, doctor, evidence and cleanup: [verify](../verify/SKILL.md). Decision record:
[ADR 0008](../../../docs/adr/0008-plugins-one-manifest-grant-or-sandbox.md).

## Sub-features

- **Manifest loader** (`manifest.ts`, `yaml.ts`): reads upstream's `plugin.yaml`; `capabilities` and `requires_auth` fail closed.
- **Hook dispatch** (`hooks.ts`): upstream's names and keyword arguments; unknown arguments pass through; the 30 s budget, where a timeout counts as a crash; directory order.
- **Policy hooks fail closed**: a `pre_tool_call` hook that blocks, throws or hangs means the tool does not run. An empty block message is ignored.
- **Call-site flags** (`site.ts`): each site is `python`, `shadow` or `ts`. Effectful sites use replay shadow, so exactly one implementation dispatches a real effect.
- **Plugin state** (`state.ts`): `ctx.state`, capped at 10 MiB as upstream.
- **Python side** (`python-rpc.ts`): the JSON-RPC shape for hooks that stay in the gateway host.
- **Fixtures** (`packages/plugin-host/fixtures`): `portable-notes`, `first-party-guard`, and a recorded Python-side `pre_tool_call`.

## How to get to it (user POV)

A plugin is a directory with a `plugin.yaml`. The session loop reaches the host at its hook
call sites. The golden scripts `hook-blocks-tool`, `hook-crashes`, `hook-time-budget` and
`three-plugins-hook-order` load plugins through the real host and play a turn.

## Driving it with verify.ts

```sh
bun .claude/skills/verify/verify.ts run plugins
```

Runs the four test files of `packages/plugin-host/src` (32 tests), then
`packages/golden/src/cli.ts check` on the four hook scripts, which must print 4 `same` lines.
Proof: `PASS plugins ... 1/1 drives`.

## Gotchas

- Nothing here isolates a plugin. Grant and sandbox (the five-part boundary) are specified only; the phase 4 isolation tests do not exist yet. Do not claim isolation from this run.
- The Python hook round trip is replayed from a recorded fixture. No Python runs.
- A plugin in the same isolate cannot be stopped by a timer if it loops on the CPU; the budget test covers a hook that never returns, not a busy loop. The platform kill is a host test (guide 7.4).
