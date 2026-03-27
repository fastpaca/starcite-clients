# @starcite/react

React-first chat hook for a single durable Starcite session.

This package replaces AI SDK `useChat` wiring for Starcite-backed chats while
keeping a familiar surface:

- `messages`
- `sendMessage`
- `status`

For AI-assisted onboarding, start with `docs/ai-onboarding.md`.
For the architecture spec, see `docs/ai-sdk-migration.md`.

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

## Server Integration

`useStarciteChat` only covers the frontend session state and durable user
appends. The default server model is lifecycle-driven: your backend listens
with `starcite.on("session.created", ...)`, decides whether a given agent owns
that session, binds owned sessions with `starcite.session({ identity, id })`,
then attaches `session.on("event", ...)` handlers and appends assistant chunks
back into the same session. The SDK handles the per-session stream lifecycle
after the session is bound.

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
- `sendMessage(...)` performs the durable append and expects backend `.on(...)` handlers to react.
- When backed by `StarciteSession`, transient append transport failures are retried in-order instead of failing fast.
- Terminal append failures pause the SDK outbox by default; inspect `session.appendState()` and use `session.resumeAppendQueue()` or `session.resetAppendQueue()` for operational recovery.
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
