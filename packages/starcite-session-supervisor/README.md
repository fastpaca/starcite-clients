# @starcite/session-supervisor

Opinionated server-side supervisor for Starcite session agents.

Use this when you want one agent identity to run across many Starcite sessions
without wiring session lifecycle, replay, or live delivery yourself.

The supervisor owns:

- tenant lifecycle subscriptions through `starcite.on(...)`
- one `SessionAgent` instance per detected session
- session attachment and detachment for the supervised agent identity
- retained-history replay before live delivery begins
- in-process delivery watermarks so restarted agents do not re-handle old events
- ignoring events emitted by the supervised agent identity itself

Your agent owns:

- how to respond to events in `receive(event)`
- optional `start`, `archive`, `unarchive`, `stop`, and `shutdown` behavior
- any durable checkpointing or external orchestration layered on top

## Install

```bash
npm install @starcite/session-supervisor @starcite/sdk
```

## Example

```ts
import { Starcite, type TailEvent } from "@starcite/sdk";
import {
  SessionAgent,
  SessionAgentSupervisor,
} from "@starcite/session-supervisor";

const starcite = new Starcite({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
});

class PlannerAgent extends SessionAgent {
  async receive(event: TailEvent): Promise<void> {
    if (event.type !== "message.user") {
      return;
    }

    await this.session.append({
      type: "message.assistant",
      source: "agent",
      payload: {
        text: "Planning started.",
      },
    });
  }
}

const supervisor = new SessionAgentSupervisor({
  Agent: PlannerAgent,
  agent: starcite.agent({ id: "planner" }),
  starcite,
});

await supervisor.start();
```

## Agent Model

- One supervisor manages one agent identity.
- One detected session gets one `SessionAgent` instance.
- `start()` is called when that agent becomes live on the session.
- Retained history is replayed into `receive(event)` before live events begin.
- `stop(cause)` runs when the session freezes, archives, or the supervisor stops.
- `archive()` and `unarchive()` are optional metadata lifecycle hooks.
- `shutdown()` is terminal disposal for that session agent object.

This package is intentionally opinionated for agent-style session processing.
If you need durable checkpoints or more specialized orchestration, layer that on
top of `SessionAgent` instead of pushing more generic lifecycle plumbing into the
base API.
