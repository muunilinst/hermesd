# hermesd

a port of hermes that doesn't need a VM running all the time.

> note: this is pretty much a work in progress, so jump in for a bumpy ride.

a port of hermes that can run on (1) teenytiny.computer something we are building hehe (2) cloudflare durable objects (3) rivet.dev

it will have a focus on reliability, observability and performance.

the objective is not feature parity with hermes, but rather an agent that can take over your existing hermes setup, feels like hermes and is more performant underneath.

## but why?

while hermes is a pretty cool agent that takes care of you, it requires a full fledged machine running in the background to serve you as well. with compute prices going up even at a run of the mill vps provider, paying for a box that is idle most the time makes no sense. it would also be cool, if the system was more reliable than restarting when the system crashes all the time.

## how?

the plan is to port hermes incrementally, starting with the core agentic conversation loop and eventually cover some of the essential gateways/platforms.

after each step we verify the new component with the existing hermes code.

this project will rely heavily AI assistance and I wonder how else I would be able to do it.

## where we are

the design is the porting guide (rev 5.1). we start with its milestone 1:
prove crash recovery at every handoff on the smallest slice, before any
estimate. nothing is demonstrated yet; [STATUS.md](STATUS.md) tracks each
mechanism and each fault test (D1 to D17).

## layout

| path | what it holds |
| --- | --- |
| `packages/host` | the `Host` interface (guide 4.6). agent code imports only this, never a platform SDK |
| `packages/host-node` | in-memory platform simulator with Durable Objects and Rivet rule sets, crash and timer fault hooks |
| `packages/host-cloudflare` | the Durable Objects adapter (also the TeenyTiny v2 adapter); tests run on local workerd |
| `packages/runtime` | adapter-independent rules: wake obligations, outbox, `session_admissions` inbox, sweeper |
| `packages/executor-protocol` | the executor contract (guide 3.4), `deriveOpId`, and the guest launch reconciliation table |
| `packages/executor-model` | in-memory reference executor cell, simulated VM lifecycle and guest |
| `packages/guest-helper` | prototype guest helper: launch journal, `O_EXCL` claim shim, reconciliation |
| `packages/plugin-host` | manifest loader, hook dispatch with upstream semantics, per-call-site python/shadow/ts flags |
| `packages/faults` | the D1 to D17 catalogue (guide 7.3) and backend-agnostic fault tests |
| `packages/contracts` | weekly-diff guards over the upstream contract surfaces (guide 7.1) |
| `contracts/` | static extractors, extracted upstream surfaces, and per-table port decisions |
| `upstream/pin.json` | the upstream hermes-agent commit we test against |

each package with design choices has a `NOTES.md` that records how we read
the guide where it was ambiguous.

## develop

needs node 22.18 or later (tests run the `.ts` files directly with `node --test`).

```sh
npm install
npm run check   # typecheck + tests
```
