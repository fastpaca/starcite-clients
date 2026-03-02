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
import { Starcite } from "@starcite/sdk";
import { createStarciteChatTransport } from "@starcite/ai-sdk-transport";

const starcite = new Starcite({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
});

// Use a server-created session token in frontends:
const { token } = await getSessionTokenSomehow();
const session = starcite.session({ token });

const transport = createStarciteChatTransport({
  session,
});

const chat = useChat({
  transport,
});
```

## Transport Behavior

`sendMessages` appends one outgoing message with:

- `type: "chat.user.message"`
- `source: "use-chat"`
- `payload: { kind: "chat.user.message", message: Omit<UIMessage, "id"> }`

Then it subscribes to the same session tail and forwards each event with
`event.seq > cursor` as a `ReadableStream<ChatChunk>`.

`reconnectToStream` returns `null` when there is no in-progress generation
(session events are empty or the last assistant chunk is a `finish`). When a
generation was interrupted mid-stream it resumes from the last tracked cursor.

## Notes

- Payloads are wrapped in strict chat envelopes.
- Incoming assistant events must carry:
  - `{ kind: "chat.assistant.chunk", chunk: UIMessageChunk }`
- `toUIMessagesFromEvents(...)` / `toModelMessagesFromEvents(...)` expect strict
  envelope payloads and throw on invalid payloads.
- Envelope, message, and chunk shapes are passthrough at runtime, so custom AI SDK
  extensions are preserved.

## Exported Shapes

- `createStarciteChatTransport`
- `appendUserMessageEvent`
- `appendAssistantChunkEvent`
- `StarciteChatTransportOptions`
- `SendMessagesOptions`
- `ReconnectToStreamOptions`
- `ChatChunk`
- `toUIMessagesFromEvents`
- `toModelMessagesFromEvents`

## Example: factory with prebuilt session

```ts
const transport = createStarciteChatTransport({
  session,
});
```

## Event Contract

Outgoing user append:

- `chat.user.message`

Incoming assistant tail events:

- Payloads must use `{ kind: "chat.assistant.chunk", chunk }` envelopes.
- Transport validates the envelope and forwards `chunk` to `useChat`.

Your backend should emit valid AI SDK chunks (including `finish`) wrapped in
transport envelopes.

## Options

- `session` (required): a `StarciteSession` created with the same backend token used by your UI.
