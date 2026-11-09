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
