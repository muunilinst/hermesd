# 0001. Port the protocol, not the code base; upstream is the test oracle

- Status: Accepted
- Date: 2026-11-11
- Source: porting guide rev 5.1, sections 2.1, 2.2, 6.1, 6.2

## Context

Hermes is a Python agent of about 250,000 lines. At the pinned commit (`a9ff9799`, 2026-11-07)
upstream had made about 370 commits a day for 30 days and shipped a patch release every 0 to
10 days. A fork that owns the whole code base re-ports it every week.

There are three ways to move it onto actors:

| | A. Full port | B. Runtime shim | C. Protocol port |
| --- | --- | --- | --- |
| We rewrite | Everything | Nothing; Python Hermes runs in a VM behind a routing actor | The loop, the store, the plugin host |
| Upstream tracking | Every change is a manual re-port | Bump the version | Only contract changes need work |
| Runs in a Worker | Yes | No | Yes |
| Plugins | Must redo every plugin | All Python plugins work | Portable plugins work; Python in the gateway host; JS native |
| Cost | Months, then permanent lag | Days | Weeks, plus weekly tracking (provisional) |

## Decision

Option C is the port. Option B is the day-one baseline and the oracle the tests compare with.

The port owns five things and tests everything else against upstream: the conversation loop
(rewritten), the session store (same rows), the tool registry (same schemas), the plugin
manager (same manifest and hook names), and the provider formats. The 26 chat adapters stay in
Python (see [0009](0009-gateway-stateless-router-python-stays.md)).

The target has one actor per session and four contracts below it: the model (an abortable
fetch), the executor VM, the gateway host, and HTTP MCP servers. The actor is the only durable
unit. Everything below it is reached through a contract the actor can retry against.

We never merge upstream code. We pin one commit, extract its contract surfaces, and test.

## Consequences

- Upstream's commit rate costs us only when a contract changes.
- The port is not at feature parity, and the README says that is not the goal.
- Option C converges on a full port over time; it orders the work so the oracle runs at every step.
- If the goal changes to "an agent of our own with Hermes as a reference", a hard fork becomes right. That is phase 7 of [0011](0011-incremental-port-flags-phases-milestone-1.md), a decision and not work.

## How we check it

`upstream/pin.json` names the commit. `contracts/extract` reads it by static analysis;
`packages/contracts` fails when a surface moves. See [0010](0010-verification-specified-is-not-demonstrated.md).
