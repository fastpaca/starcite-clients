# @starcite/ai-sdk-transport

Minimal `useChat` transport adapter for Starcite sessions.

This package keeps Starcite as the backend event stream and translates
Starcite tail events into AI SDK UI message chunks.

## Install

```bash
npm install @starcite/ai-sdk-transport @starcite/sdk ai
```

## Usage

```ts
import { useChat } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import { createStarciteClient } from "@starcite/sdk";
import { StarciteChatTransport } from "@starcite/ai-sdk-transport";

const client = createStarciteClient({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
  // Optional: enforce payload schema at SDK boundary.
  payloadSchema,
});

const transport = new StarciteChatTransport({
  client,
  // Optional: stable per-tab producer id override.
  producerId: `producer:web:${crypto.randomUUID()}`,
  // Optional: custom payload protocol over the wire.
  protocol: {
    buildUserPayload: ({ message }) => ({
      kind: "user",
      prompt: message.text ?? "",
    }),
    parseTailPayload: (payload) =>
      payload.kind === "chunk" ? payload.chunk : null,
  },
});

const chat = useChat({
  transport: transport as unknown as ChatTransport,
});
```

## Event Contract

Outgoing user append:

- `chat.user.message`

Incoming assistant tail events:

- First `content` or `chat.response.delta` payload with text becomes the assistant response.
- `chat.response.error` becomes an error assistant response.

Each response is emitted as one complete UI chunk sequence:

- `start`
- `text-start`
- `text-delta`
- `text-end`
- `finish`

## Options

- `client` (required)
- `userAgent` (default `user`)
- `producerId` (optional; defaults to unique per transport instance)
- `protocol` (optional; `StarciteProtocol<TPayload>`)

Payload validation is intentionally kept in `@starcite/sdk` via `payloadSchema`.
