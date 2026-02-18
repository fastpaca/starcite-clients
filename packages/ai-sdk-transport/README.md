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
import { createStarciteClient } from "@starcite/sdk";
import { StarciteChatTransport } from "@starcite/ai-sdk-transport";

const client = createStarciteClient({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
  // Optional: enforce payload schema at SDK boundary.
  payloadSchema,
});

const transport = new StarciteChatTransport<Payload>({
  client,
  // Optional when your runtime cannot infer creator principal from apiKey.
  creatorPrincipal: {
    tenant_id: "acme",
    id: "org:acme",
    type: "user",
  },
});

const chat = useChat({
  transport,
});
```

## Event Contract

Outgoing user append:

- `chat.user.message`

Incoming assistant tail events:

- Payloads are passed through directly to `useChat` as AI SDK `UIMessageChunk`.
- No transport-level payload mapping or validation is applied.

Your backend should emit valid AI SDK chunks (including `finish`) in event payloads.

## Options

- `client` (required)
- `creatorPrincipal` (optional; forwarded to `createSession` as `creator_principal`)
- `userAgent` (default `user`)
- `producerId` (optional; defaults to unique per transport instance)

Payload validation is intentionally kept in `@starcite/sdk` via `payloadSchema`.
