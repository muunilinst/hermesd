# 0011. Port incrementally behind per-call-site flags; milestone 1 before any estimate

- Status: Accepted; milestone 1 in progress
- Date: 2026-11-11
- Source: porting guide rev 5.1, sections 9, 10

## Context

Nothing in Hermes is unportable, but the volume is large and the recovery design is unproven.
Durations written before the recovery gaps were closed are guesses. Porting more of Hermes to
TypeScript does not, on its own, add durability; the contracts and the fault tests do.

## Decision

**One flag per call site.** Every tool, hook and adapter is `python` (served by the gateway
host or the machine), `shadow` (both run, Python answers, TypeScript is compared), or `ts`. A
site moves to `shadow` when its TypeScript version compiles, and to `ts` when the comparison
has shown zero differences over a stated number of real turns. A regression flips it back.
The flag is data in the actor, so it changes without a deploy. Nothing is deleted from Python
until the site has been `ts` for a full upstream minor release.

**Shadow never acts twice.** Pure sites use live shadow. Effectful sites use replay shadow:
the Python handler runs live, its inputs and outbound calls are recorded, and the TypeScript
handler runs later against the recording with outbound calls mocked. The manifest marks every
site pure or effectful; unmarked means effectful.

**Rollback is more than a flag.** It is safe only because both sides read and write the same
rows at the same schema version ([0006](0006-store-same-rows-four-owners.md)). Each phase exit
test includes "flip back and run 3 turns".

**Seven phases, in dependency order.**

| Phase | Moves | Decided by |
| --- | --- | --- |
| 0 | Nothing to TypeScript. Upstream runs in a VM; the executor contract is built and the terminal tool points at it | D2, D4, D5, D10, D11, D13 to D17 on a real executor, helper and VM |
| 1 | The loop and the store into the session and profile actors | 20 transcripts; the state round trip; D1, D3, D6, D7, D8, D9, D12 |
| 2 | Agent-internal and HTTP tools | Schema parity; a differential test per tool |
| 3 | File and terminal handlers | File differential tests; phase 0 tests rerun with the TypeScript handler |
| 4 | The plugin host | The isolation test per platform |
| 5 | Adapters, for the platforms we serve | Adapter conformance tests |
| 6 | The machine side (browser, stdio MCP host, kernels) | A language preference, not a capability gain |
| 7 | Detach from upstream | A decision: when lines changed per pin bump stay near zero |

Phases 0 to 3 are worth doing on any reading of the product. Phases 2 to 6 can overlap once
phase 1 is done.

**Milestone 1 comes first.** One tenant, one provider, one machine tool (`terminal`), one
approval flow (`clarify`). Its job is to prove crash recovery at every handoff, not to cover
features: (1) inventory upstream's tables and recovery path; (2) the executor state machine on
a TeenyTiny VM; (3) the upstream baseline in a VM; (4) the `Host` interface, the session and
profile actors, the async loop against a scripted model; (5) all 17 fault tests on each host;
(6) the contract extractors and 5 transcripts; (7) one portable and one first-party JS plugin;
(8) measure memory, awake seconds, rows and commits per turn, wake latency; (9) decide durable
state or replay, and only then estimate.

**Approve each later phase on portability, shutdown survival, wake latency and plugin
isolation; never on hosting cost.** Per turn the model costs about 10,000 times more than the
hosting, so a cost argument is cancelled when checked.

## Consequences

- Scope grows only after every milestone 1 row is green.
- The repository runs ahead of the milestone in breadth (20 transcripts, four provider formats, a plugin host) and behind it in depth: no fault test has run on a real host.
- Nine open questions (guide 10.3, listed in `STATUS.md`) must be answered before the port starts in earnest.

## How we check it

`STATUS.md` is the scoreboard: one row per mechanism and one per fault test, by host.
`packages/plugin-host/src/site.ts` holds the three-state flag and its test. The milestone is
judged by the three numbers of [0010](0010-verification-specified-is-not-demonstrated.md) and
by one yes or no: did every handoff survive every shutdown.
