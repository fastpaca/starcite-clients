# @starcite/sdk

TypeScript SDK for [Starcite](https://starcite.ai), built around the core flow:

1. Create a session
2. Append ordered events
3. Tail from a cursor over WebSocket

## Install

```bash
npm install @starcite/sdk
```

## Requirements

- Node.js 22+, Bun, or a modern browser/runtime with `fetch` and `WebSocket`
- A running Starcite API (default: `http://localhost:4000`)

The SDK normalizes your base URL to include `/v1`.

## Quick Start

```ts
import { createStarciteClient } from "@starcite/sdk";

const client = createStarciteClient({
  baseUrl: "http://localhost:4000",
});

const session = await client.create({
  id: "ses_demo",
  title: "Draft contract",
  metadata: { tenant_id: "acme" },
});

await session.append({
  agent: "researcher",
  text: "Found 8 relevant cases.",
});

for await (const event of session.tail({ cursor: 0 })) {
  console.log(event.seq, event.agent, event.text);
}
```

## Base URL and Auth Headers

```ts
import { createStarciteClient } from "@starcite/sdk";

const client = createStarciteClient({
  baseUrl: process.env.STARCITE_BASE_URL ?? "http://localhost:4000",
  headers: {
    Authorization: `Bearer ${process.env.STARCITE_TOKEN}`,
  },
});
```

## High-Level and Raw Append Modes

High-level append:

```ts
await client.session("ses_demo").append({
  agent: "drafter",
  text: "Reviewing clause 4.2...",
});
```

Raw append (full protocol fields):

```ts
await client.session("ses_demo").appendRaw({
  type: "content",
  actor: "agent:drafter",
  payload: { text: "Reviewing clause 4.2..." },
  idempotency_key: "req-123",
  expected_seq: 3,
});
```

## Tail Options

```ts
const abort = new AbortController();

for await (const event of client.session("ses_demo").tail({
  cursor: 0,
  agent: "drafter",
  signal: abort.signal,
})) {
  console.log(event);
}
```

`tail()` replays `seq > cursor` and then streams live events on the same socket.

## Error Handling

```ts
import {
  StarciteApiError,
  StarciteConnectionError,
  createStarciteClient,
} from "@starcite/sdk";

const client = createStarciteClient();

try {
  await client.create();
} catch (error) {
  if (error instanceof StarciteApiError) {
    console.error(error.status, error.code, error.message);
  } else if (error instanceof StarciteConnectionError) {
    console.error(error.message);
  } else {
    throw error;
  }
}
```

## API Surface

- `createStarciteClient(options?)`
- `starcite` (default client instance)
- `StarciteClient`
  - `create(input?)`
  - `createSession(input?)`
  - `session(id, record?)`
  - `appendEvent(sessionId, input)`
  - `tailEvents(sessionId, options?)`
  - `tailRawEvents(sessionId, options?)`
- `StarciteSession`
  - `append(input)`
  - `appendRaw(input)`
  - `tail(options?)`
  - `tailRaw(options?)`

## Local Development

```bash
bun install
bun run --cwd packages/typescript-sdk build
bun run --cwd packages/typescript-sdk test
```

## Links

- Product docs and examples: https://starcite.ai
- API contract: https://github.com/fastpaca/starcite/blob/main/docs/api/rest.md
- WebSocket tail docs: https://github.com/fastpaca/starcite/blob/main/docs/api/websocket.md
