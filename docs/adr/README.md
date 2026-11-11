# Architecture decision records

The porting guide ("How to run Hermes on TeenyTiny, Durable Objects, and Rivet Actors",
revision 5.1, November 2026) is a 60-page argument. These records are its decisions, one per
file, in the order the guide makes them. Each record gives the context, the decision, what
follows from it, and how the repository checks it. The guide stays the source for evidence,
counts, prices and sources; a record cites the guide section it comes from.

The guide is not in this repository. Where a record and the guide disagree, the guide at
rev 5.1 is right and the record has a bug.

| # | Decision | Guide | Where it lives |
| --- | --- | --- | --- |
| [0001](0001-protocol-port-upstream-as-oracle.md) | Port the protocol, not the code base; upstream is the test oracle | 6.1, 2.1 | `upstream/pin.json`, `contracts/` |
| [0002](0002-durable-state-not-replay.md) | Durable state, not replay | 3.3 | `packages/session-actor` |
| [0003](0003-one-host-interface-three-platforms.md) | One `Host` interface hides the three platforms | 4.6, 6.8, 2.8 | `packages/host*` |
| [0004](0004-executor-contract-unknown-is-an-answer.md) | The executor contract: derived IDs, epochs, incarnations, the launch journal | 3.4 | `packages/executor-*`, `packages/guest-helper` |
| [0005](0005-loop-rows-wake-obligations-sweeper.md) | Every blocking call becomes a row and a return; wake obligations and a sweeper bring the actor back | 6.3, 4.6 | `packages/session-actor`, `packages/runtime` |
| [0006](0006-store-same-rows-four-owners.md) | Same rows at schema 32, four owners, a transactional outbox | 2.4, 6.4 | `packages/session-actor`, `packages/profile-actor`, `packages/state-port` |
| [0007](0007-tools-schema-is-data.md) | A tool schema is data; the handler is the only code | 2.5, 6.5 | `contracts/upstream/tool-schemas.json`, `packages/session-actor/src/tools` |
| [0008](0008-plugins-one-manifest-grant-or-sandbox.md) | One manifest, three places to run; a third-party plugin is granted or sandboxed | 2.6, 3.5, 6.6 | `packages/plugin-host` |
| [0009](0009-gateway-stateless-router-python-stays.md) | The gateway is a stateless router; the gateway host stays in Python | 6.7, 6.9 | not built yet |
| [0010](0010-verification-specified-is-not-demonstrated.md) | Four verification rules; specified is not demonstrated | 7, 10.1 | `packages/contracts`, `packages/golden`, `packages/faults`, `STATUS.md` |
| [0011](0011-incremental-port-flags-phases-milestone-1.md) | Port incrementally behind per-call-site flags; milestone 1 before any estimate | 9, 10.2 | `packages/plugin-host/src/site.ts`, `STATUS.md` |
| [0012](0012-run-the-repository-on-bun.md) | Run the repository on bun (a tooling decision, not from the guide) | none | `package.json`, `.bun-version`, `.github/workflows/ci.yml` |

## Status words

- **Accepted**: we build to this decision.
- **Specified**: the rules are written down. **Demonstrated**: the fault test passed on a real
  host with a real executor, a real guest helper and a real VM. Nothing is demonstrated yet;
  [STATUS.md](../../STATUS.md) has the current state of each mechanism.
- Evidence labels in the guide: D (primary source), I (inferred), M (measured at the pinned
  commit), H (hypothesis). A record repeats a label only where the decision rests on an H.

## Adding a record

Take the next number. Use the headings of the records here: Status, Context, Decision,
Consequences, How we check it. Do not edit the decision of an accepted record; write a new one
and mark the old one "Superseded by NNNN". Each package's `NOTES.md` records how we read the
guide where it was ambiguous; a reading that changes a decision belongs here instead.
