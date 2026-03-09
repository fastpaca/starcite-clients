# Franken Monolith Example

A live three-agent workflow running against real APIs:

- `@starcite/sdk` for the shared durable session timeline
- OpenAI Responses API for stateful agent turns
- one Node.js process that subscribes to events and orchestrates agents

## What it demonstrates

- a coordinator agent that plans and requests approval
- a researcher agent that produces constraints and findings
- a writer agent that drafts and finalizes
- user-in-the-loop approval as an event on the same session timeline
- OpenAI `previous_response_id` recovery per agent from Starcite history

## Run

From the repo root:

```bash
bun install
cp examples/franken-monolith/.env.example examples/franken-monolith/.env.local
export $(cat examples/franken-monolith/.env.local | xargs)

bun run --cwd examples/franken-monolith start -- \
  --prompt "Draft a response to a customer asking for a refund on an enterprise account."
```

Required env vars:

```bash
OPENAI_API_KEY=...
STARCITE_API_KEY=...
```

Optional env vars:

```bash
STARCITE_BASE_URL=https://api.starcite.io
OPENAI_MODEL=gpt-4o-mini
OPENAI_COORDINATOR_MODEL=gpt-4o-mini
OPENAI_RESEARCHER_MODEL=gpt-4o-mini
OPENAI_WRITER_MODEL=gpt-4o-mini
LIVE_PROMPT="..."
```

The script waits for the approval checkpoint. If the terminal is interactive,
it prompts for approval text. If not, it auto-approves with a default message.

## Architecture

`src/index.ts`
: CLI entry point. Creates one Starcite session with per-agent identity handles,
boots the worker, sends the user message, waits for approval + final answer.

`src/responses-worker.ts`
: Event-driven orchestration for coordinator, researcher, and writer.
Subscribes to the session and reacts to each event type.

`src/openai-responses.ts`
: Calls OpenAI `responses.create` with streaming chunks and records each
provider turn back into Starcite.

`src/contracts.ts`
: Event type constants and payload helpers.
