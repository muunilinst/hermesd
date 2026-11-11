# 0008. One manifest, three places to run; a third-party plugin is granted or sandboxed

- Status: Accepted; the host is built for milestone 1; isolation is specified only
- Date: 2026-11-11
- Source: porting guide rev 5.1, sections 2.6, 3.5, 6.6

## Context

An upstream plugin is a `plugin.yaml` manifest and a `register(ctx)` function that adds tools
and hooks. There are 38 hook names. A callback that raises or runs past 30 s is logged and
skipped. Plugins run in the agent's process with no sandbox, and the catalogue has 1,065
entries, almost all Python.

Moving a plugin into the actor's isolate does not change its permissions: it sees the same
globals, network and secrets, and a synchronous loop cannot be stopped by a timer in the same
thread. Python behind JSON-RPC changes the transport, not the permissions.

## Decision

**Keep the manifest and every hook name. Change only where the code runs.** The manifest gains
`runtime: js | python | portable`:

- `portable`: skills and MCP, no code. Runs in the actor.
- `js`: `register(ctx)` in the actor. For first-party plugins.
- `python`: unchanged, in the gateway host, over JSON-RPC.

Hook names and arguments are the same in all three.

**Rules the host enforces:** join `pre_llm_call` outputs in alphabetical order by plugin
directory; a middleware may call `next` once; pass unknown keyword arguments through, because
upstream adds them freely, and never validate a fixed list.

**Two words, kept apart.** *API discipline* is a frozen `ctx`, declared capabilities, the 30 s
hook budget (a timeout counts as a crash), and `ctx.state` capped at 10 MiB; `capabilities`
and `requires_auth` fail closed. It stops mistakes, not attackers, and it is what first-party
plugins get. *Isolation* is a boundary hostile code cannot cross.

**A third-party plugin never runs in the actor's isolate or in a gateway host shared between
tenants.** Every install takes one of two forms, and the install step says which:

- **Grant:** beside the tenant's agent, with the agent's full authority. Upstream's model today.
- **Sandbox:** behind a five-part boundary measured against the agent itself: a separate process or isolate the platform treats as a tenant boundary and kills from outside; a token minted for that plugin and tenant; no file access or a private directory; a network allow-list enforced outside the sandbox; memory and CPU limits enforced by the kernel or platform.

Community plugins use the sandbox unless the tenant explicitly grants. A Node `worker_thread`
is not a sandbox, and neither is a separate actor. What meets it: on Cloudflare a separate
Worker with only its own bindings; on TeenyTiny a second VM or a `runsc` container per plugin;
on Rivet a sandboxed process outside the actor (not verified).

## Consequences

- Existing Python plugins keep working, at the cost of a remote hop per hook. Above 50 ms on `pre_llm_call`, forward only the hooks a plugin declares.
- Multi-tenancy has three tiers: no native plugins (shared process), first-party native plugins (one process per trust group), user-installed native plugins (one VM per tenant).
- TeenyTiny is "not ready for public arbitrary code" until its security review closes, so sandboxed third-party plugins wait for it.

## How we check it

`packages/plugin-host`: manifest, hook dispatch, state cap, call-site flags, a recorded Python
`pre_tool_call`. Golden scripts `hook-blocks-tool`, `hook-crashes`, `hook-time-budget`,
`three-plugins-hook-order`. The isolation tests of phase 4 (a third-party plugin cannot read
the agent's environment, files, or network outside its allow-list) do not exist yet. Drive it
with the `verify-plugins` skill.
