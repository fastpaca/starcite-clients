# @starcite/sdk

TypeScript SDK for [Starcite](https://starcite.ai), built for multi-agent systems.

Built for teams where multiple producers need shared, ordered context.

`@starcite/sdk` helps you:

- listen and monitor what multiple agents are doing,
- keep frontend state consistent with a single ordered event source,
- replay history and continue sessions reliably.

Typical flow:

1. create a session
2. list sessions when needed
3. append ordered events
4. tail from a cursor over WebSocket

For multi-agent systems:

- a) listen and monitor all producers in real time,
- b) keep frontend consistency by reading from the same ordered stream.

## Install

```bash
npm install @starcite/sdk
```

## Requirements

- Node.js 22+, Bun, or any modern runtime with `fetch` and `WebSocket`
- Your Starcite Cloud instance URL (`https://<your-instance>.starcite.io`)
- Your Starcite API key / service JWT

The SDK normalizes the base URL to `/v1` automatically.

## Quick Start

```ts
import { createStarciteClient } from "@starcite/sdk";

const client = createStarciteClient({
  baseUrl: process.env.STARCITE_BASE_URL ?? "https://<your-instance>.starcite.io",
  apiKey: process.env.STARCITE_API_KEY,
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

## Authentication

Use your service JWT/API key once at client creation. The SDK injects
`Authorization: Bearer <token>` for all HTTP calls and WebSocket tail upgrades.

```ts
import { createStarciteClient } from "@starcite/sdk";

const client = createStarciteClient({
  baseUrl: process.env.STARCITE_BASE_URL ?? "https://<your-instance>.starcite.io",
  apiKey: process.env.STARCITE_API_KEY,
});
```

Token refresh is not built in. If a key is revoked/rotated and requests start
returning `401`, create a new client with the replacement key and reconnect
tails from your last processed cursor.

## List Sessions

```ts
const page = await client.listSessions({
  limit: 20,
  metadata: { tenant_id: "acme" },
});

for (const session of page.sessions) {
  console.log(session.id, session.title, session.created_at);
}

console.log("next cursor:", page.next_cursor);
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
  reconnect: true,
  reconnectDelayMs: 3000,
  signal: controller.signal,
})) {
  console.log(event);
}
```

`tail()` replays `seq > cursor`, streams live events, and automatically reconnects
on transport failures while resuming from the last observed `seq`.

- Set `reconnect: false` to disable automatic reconnect behavior.
- By default, reconnect retries continue until the stream is aborted or closes gracefully.
- Use `reconnectDelayMs` to control retry cadence for spotty networks.

## Browser Restart Resilience

`tail()` reconnects robustly for transport failures, but browser refresh/crash
resets in-memory state. Persist your last processed `seq` and restart from it.

```ts
const sessionId = "ses_demo";
const cursorKey = `starcite:${sessionId}:lastSeq`;

const rawCursor = localStorage.getItem(cursorKey) ?? "0";
let lastSeq = Number.parseInt(rawCursor, 10);

if (!Number.isInteger(lastSeq) || lastSeq < 0) {
  lastSeq = 0;
}

for await (const event of client.session(sessionId).tail({
  cursor: lastSeq,
  reconnect: true,
  reconnectDelayMs: 3000,
})) {
  // Process event first, then persist cursor when your side effects succeed.
  await renderOrStore(event);
  lastSeq = event.seq;
  localStorage.setItem(cursorKey, `${lastSeq}`);
}
```

This pattern protects against missed events across browser restarts. Design your
event handler to be idempotent by `seq` to safely tolerate replays.

## Error Handling

```ts
import {
  StarciteApiError,
  StarciteConnectionError,
  createStarciteClient,
} from "@starcite/sdk";

const client = createStarciteClient({
  baseUrl: process.env.STARCITE_BASE_URL ?? "https://<your-instance>.starcite.io",
  apiKey: process.env.STARCITE_API_KEY,
});

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
  - `listSessions(options?)`
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

Optional reconnect soak test (runs ~40s, disabled by default):

```bash
STARCITE_SDK_RUN_SOAK=1 bun run --cwd packages/typescript-sdk test -- test/client.reconnect.integration.test.ts
```

## Links

- Product docs and examples: https://starcite.ai
- API contract: https://github.com/fastpaca/starcite/blob/main/docs/api/rest.md
- WebSocket tail docs: https://github.com/fastpaca/starcite/blob/main/docs/api/websocket.md
