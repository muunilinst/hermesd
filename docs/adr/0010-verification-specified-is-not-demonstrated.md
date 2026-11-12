# 0010. Four verification rules; specified is not demonstrated

- Status: Accepted
- Date: 2026-11-11
- Source: porting guide rev 5.1, sections 7, 10.1

## Context

The port tracks upstream by testing against it, not by merging from it. Revision 4 of the
guide called four recovery gaps closed when they were only written down. A mock executor hides
the case the design exists for: a command that ran and was not reported.

## Decision

**Two status words.** A mechanism is *specified* when its rules are written down and
*demonstrated* when its fault test has passed on a real host, with a real executor, a real
guest helper and a real VM. A pass on the in-memory model or the in-memory Node host never
demonstrates a mechanism. `STATUS.md` changes a row only in the same change that adds the
evidence.

**Rule 1: pin upstream and extract its contract surfaces every week.** Tool schemas
(byte-identical for every supported tool), the prompt surface (same system prompt for the
fixture configs), the hook ABI (a new name fails), manifests (all parse and are classed), the
state schema (every table has a decision), and ledger compatibility (same statuses and
uniqueness rules). A failing diff names what upstream changed.

**Rule 2: golden transcripts.** A scripted model returns fixed answers. Record every request
the agent sends, in order, and every `messages` and `session_admissions` row it writes. Play
the same script through upstream and through the port; compare; ignore timestamps. Twenty
scripts.

**Rule 3: seventeen fault tests.** D1 to D17 each inject one failure and state what must be
true afterwards. D9 has eight cases, D11 five, D14 four. "One run" is checked on the VM from a
counter the command increments, never inferred from a receipt or a claim file.

**Rule 4: four hosts.** In-memory Node for fast feedback; Durable Objects on workerd, then
deployed; TeenyTiny v2 on one-node and two-node fleets; Rivet locally, then cloud. Plus
host-specific tests (an immediate code update during a 60 s model call; kill the owner right
after an acknowledged append; a CPU-looping hook killed by the platform; two parallel Rivet
actions) and five behaviors outside the surfaces: provider authentication and key rotation,
a stream dropped mid-token, cancellation at each point of a turn, hook order with three
plugins, and upstream's error text for common failures.

**Three numbers per pin bump:** compatibility failures found, engineer-hours to green, lines
changed in the port. Any of them growing month on month means move the boundary before writing
more.

## Consequences

- The surfaces and transcripts are regression tests, not a proof of equivalence.
- No estimate of the port is made until all 17 tests pass on every host.
- A test that passes locally can be reported only as a local pass. Reports must name the backend.
- The upstream side of the transcripts and the `hermes chat --resume` step are run by a person; this environment does not execute upstream Hermes.

## How we check it

| Rule | Where |
| --- | --- |
| 1 | `contracts/extract`, `contracts/upstream`, `packages/contracts`, `packages/prompt/fixtures` |
| 2 | `packages/golden` (20 scripts, port transcripts committed, upstream transcripts empty) |
| 3 | `packages/faults` (catalogue, definitions, backends `model`, `node`, `guest-process`) |
| 4 | `packages/host-node`, `host-cloudflare` on workerd, `host-rivet` on rivetkit; deployed hosts not run |

The `verify` skills under `.claude/skills` drive each of these and write evidence to
`.verify/evidence`. Their summaries always say `"demonstrated": false`.
