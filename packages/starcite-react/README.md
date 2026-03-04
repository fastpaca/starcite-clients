# @starcite/react

React-first chat hook for a single durable Starcite session.

This package replaces AI SDK `useChat` wiring for Starcite-backed chats while
keeping a familiar surface:

- `messages`
- `sendMessage`
- `status`

## Install

```bash
npm install @starcite/react @starcite/sdk ai react
```

## Usage

```tsx
import { Starcite } from "@starcite/sdk";
import { useStarciteChat } from "@starcite/react";

const starcite = new Starcite({
  baseUrl: process.env.NEXT_PUBLIC_STARCITE_BASE_URL,
});

export function Chat({ token }: { token: string }) {
  const session = starcite.session({ token });

  const { messages, sendMessage, status } = useStarciteChat({
    session,
    id: session.id,
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void sendMessage({ text: "hello" });
      }}
    >
      <button type="submit">Send</button>
      <p>Status: {status}</p>
      <pre>{JSON.stringify(messages, null, 2)}</pre>
    </form>
  );
}
```

## Hook Options

- `session` (required): session scoped to the active session token.
- `id` (optional): reset key for when you swap sessions; defaults to `session.id`.
- `userMessageSource` (optional, default `"use-chat"`): source string for user append events.
- `onError` (optional): callback for append/projection/subscription failures.

## Behavior

- Uses `session.events()` as the durable source of truth for chat state.
- Subscribes with `session.on("event", ...)` and only consumes:
  - `chat.user.message`
  - `chat.assistant.chunk`
- Appends outgoing user messages as strict chat envelopes.
- Rebuilds `UIMessage[]` from durable events whenever new chat events arrive.

## Exports

- `useStarciteChat`
- `UseStarciteChatOptions`
- `UseStarciteChatResult`
- `SendMessageInput`
- `StarciteChatSession`

### Chat Protocol Helpers

Import from `@starcite/react/chat-protocol` when you need chat envelope helpers
for server agents or custom transports:

- `chatUserMessageEventType`
- `chatAssistantChunkEventType`
- `createUserMessageEnvelope(...)`
- `createAssistantChunkEnvelope(...)`
- `parseChatPayloadEnvelope(...)`
- `appendUserMessageEvent(...)`
- `appendAssistantChunkEvent(...)`
