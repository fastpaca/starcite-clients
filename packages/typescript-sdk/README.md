# @starcite/sdk

TypeScript SDK for [Starcite](https://starcite.ai), built for multi-agent systems.

Built for teams where multiple producers need shared, ordered context.

`@starcite/sdk` helps you:

- listen and monitor what multiple agents are doing,
- keep frontend state consistent with a single ordered event source,
- replay history and continue sessions reliably.

Typical flow:

1. create a session
2. append ordered events
3. tail from a cursor over WebSocket

For multi-agent systems:

- a) listen and monitor all producers in real time,
- b) keep frontend consistency by reading from the same ordered stream.

## Install

```bash
npm install @starcite/sdk
```

## Requirements

- Node.js 22+, Bun, or any modern runtime with `fetch` and `WebSocket`
- Starcite API reachable at `http://localhost:4000` (or set `STARCITE_BASE_URL`)

The SDK normalizes the base URL to `/v1` automatically.

## Quick Start

```ts
import { createStarciteClient } from "@starcite/sdk";

const client = createStarciteClient({
  baseUrl: process.env.STARCITE_BASE_URL ?? "http://localhost:4000",
});

const session = await client.create({
  id: "ses_demo",
  title: "Draft contract",
  metadata: { tenant_id: "acme" },
});

await session.append({
  agent: "researcher",
  producerId: "producer:researcher",
  producerSeq: 1,
  text: "Found 8 relevant cases.",
});

await session.append({
  agent: "drafter",
  producerId: "producer:drafter",
  producerSeq: 1,
  text: "Drafted clause 4.2 with references.",
});

for await (const event of session.tail({ cursor: 0 })) {
  const actor = event.agent ?? event.actor;
  const text =
    event.text ?? (typeof event.payload.text === "string" ? event.payload.text : "");

  console.log(`[${actor}] ${text}`);
}
```

## Base URL and Headers

```ts
import { createStarciteClient } from "@starcite/sdk";

const client = createStarciteClient({
  baseUrl: process.env.STARCITE_BASE_URL ?? "http://localhost:4000",
  headers: {
    Authorization: `Bearer ${process.env.STARCITE_TOKEN}`,
  },
});
```

## Append Modes

Every append requires producer identity fields:

- `producerId`: stable producer identifier (for example `producer:drafter`)
- `producerSeq`: per-producer positive sequence number (1, 2, 3, ...)

High-level append:

```ts
await client.session("ses_demo").append({
  agent: "drafter",
  producerId: "producer:drafter",
  producerSeq: 1,
  text: "Reviewing clause 4.2...",
});
```

Raw append:

```ts
await client.session("ses_demo").appendRaw({
  type: "content",
  actor: "agent:drafter",
  producer_id: "producer:drafter",
  producer_seq: 3,
  payload: { text: "Reviewing clause 4.2..." },
  idempotency_key: "req-123",
  expected_seq: 3,
});
```

## Tail Options

```ts
const session = client.session("ses_demo");
const controller = new AbortController();

setTimeout(() => controller.abort(), 5000);

for await (const event of session.tail({
  cursor: 0,
  agent: "drafter",
  signal: controller.signal,
})) {
  console.log(event);
}
```

`tail()` replays `seq > cursor` and then streams live events on the same connection.

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
