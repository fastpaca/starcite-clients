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
import { StarciteChatTransport } from "@starcite/ai-sdk-transport";

const starcite = new Starcite({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
});

// Use a server-created session token in frontends:
const { token } = await getSessionTokenSomehow();
const session = starcite.session({ token });

const transport = new StarciteChatTransport({
  session,
});

const chat = useChat({
  transport,
});
```

You can also use the factory function:

```ts
import { createStarciteChatTransport } from "@starcite/ai-sdk-transport";

const transport = createStarciteChatTransport({ session });
```

## Transport Behavior

`sendMessages` appends one outgoing message with:

- `type: "chat.user.message"`
- `source: "use-chat"`
- `payload: { parts: message.parts }`

Then it subscribes to the same session tail and forwards each event with
`event.seq > cursor` as a `ReadableStream<ChatChunk>`.

`reconnectToStream` replays from the last cursor only when a previous
`sendMessages` call has established one; otherwise it returns `null`.

## Notes

- Payloads are not transformed.
- Incoming event payloads are passed directly into `useChat` as `UIMessageChunk`.
- The backend should emit valid AI SDK chunks (including `finish`) in event payloads.

## Exported Shapes

- `StarciteChatTransport` class
- `createStarciteChatTransport`
- `StarciteChatTransportOptions`
- `SendMessagesOptions`
- `ReconnectToStreamOptions`
- `ChatChunk`

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

- Payloads are passed through directly to `useChat` as AI SDK `UIMessageChunk`.
- No transport-level payload mapping or validation is applied.

Your backend should emit valid AI SDK chunks (including `finish`) in event payloads.

## Options

- `session` (required): a `StarciteSession` created with the same backend token used by your UI.
