# @starcite/ai-sdk-transport

`useChat` transport adapter for Starcite sessions.

This package lets you keep Starcite as the event/logging backend while plugging
directly into AI SDK `useChat` transport contracts.

## Install

```bash
npm install @starcite/ai-sdk-transport @starcite/sdk ai
```

## Quick Start

```ts
import { useChat } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import { createStarciteClient } from "@starcite/sdk";
import { StarciteChatTransport } from "@starcite/ai-sdk-transport";

const client = createStarciteClient({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
});

const transport = new StarciteChatTransport({
  client,
  closeOnFirstAssistantMessage: false,
});

// Structurally compatible with AI SDK ChatTransport.
const { messages, sendMessage } = useChat({
  transport: transport as unknown as ChatTransport,
});
```

## Protocol Contract

The transport appends user messages as:

- `type: "chat.user.message"`

Then it tails Starcite events and maps assistant events to UI chunks:

- `chat.response.start` -> `start`
- `chat.response.delta` -> `text-delta`
- `chat.response.end` -> `text-end` + `finish`
- `chat.response.error` -> `text-delta` (error text) + `finish(error)`

Default fallback mode also supports one-shot content events:

- `content` with `payload.text` -> `start` + `text-start` + `text-delta` + `text-end` + `finish`

## Recommended Starcite Response Events

For full streaming:

1. Emit `chat.response.start` once.
2. Emit one or more `chat.response.delta` events.
3. Emit `chat.response.end` once.

Event payload fields supported by default:

- `messageId` (optional): assistant message id
- `textPartId` (optional): text part id
- `delta` or `text`: streamed text content
- `finishReason` (optional): included in final `finish` chunk

## Transport Options

- `autoCreateSession` (default `true`): attempts to create session by `chatId` before append.
- `closeOnFirstAssistantMessage` (default `true`): useful if your assistant emits one final `content` event per response.
- `assistantAgents`: whitelist assistant agent names to consume.
- `protocol`: override event type names.
- `buildUserAppendInput`: customize how outbound `useChat` messages map to `session.append(...)`.
- `ensureSession`: custom session initialization hook.

## Reconnect Behavior

`reconnectToStream()` uses the last seen Starcite `seq` cursor per chat.  
If no cursor is known yet, it returns `null`.
