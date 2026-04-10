# @starcite/react

React hooks for durable Starcite session state and chat projection.

This package exposes:

- `useStarciteSession` for low-level event state and durable appends
- `useStarciteChat` for AI SDK-style chat state on top of the session timeline

`useStarciteChat` keeps a familiar surface:

- `messages`
- `sendMessage`
- `status`

For the migration spec, see `docs/ai-sdk-migration.md`.

## Install

```bash
npm install @starcite/react @starcite/sdk ai react
```

## `useStarciteSession`

Use this when you want raw session events and a durable `append(...)` helper
without the chat projection layer.

```tsx
import { Starcite } from "@starcite/sdk";
import { useStarciteSession } from "@starcite/react";

const starcite = new Starcite({
  baseUrl: process.env.NEXT_PUBLIC_STARCITE_BASE_URL,
});

export function Timeline({ token }: { token: string }) {
  const session = starcite.session({
    token,
    refreshToken: async ({ sessionId }) => {
      return await fetch("/api/starcite/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
        .then((response) => response.json())
        .then((response) => response.token as string);
    },
  });

  const { events, append } = useStarciteSession({
    session,
    id: session.id,
    onError(error) {
      console.error(error);
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => void append({ text: "hello", source: "ui" })}
      >
        Append
      </button>
      <pre>{JSON.stringify(events, null, 2)}</pre>
    </>
  );
}
```

`useStarciteSession` currently reads from `session.events()` and refreshes from
`session.on("event", ..., { replay: false })`, so the retained session log
stays the source of truth. `session.events()` remains supported for
compatibility but is deprecated in favor of explicit history methods on the SDK
session surface.

## `useStarciteChat`

```tsx
import { Starcite } from "@starcite/sdk";
import { useStarciteChat } from "@starcite/react";

const starcite = new Starcite({
  baseUrl: process.env.NEXT_PUBLIC_STARCITE_BASE_URL,
});

export function Chat({ token }: { token: string }) {
  const session = starcite.session({
    token,
    refreshToken: async ({ sessionId }) => {
      return await fetch("/api/starcite/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
        .then((response) => response.json())
        .then((response) => response.token as string);
    },
  });

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

`useStarciteSession`:

- `session` (required): session scoped to the active session token
- `id` (optional): reset key for when you swap sessions; defaults to `session.id`
- `onError` (optional): callback for surfaced session `error` events
- Returns `{ events, append }`

`useStarciteChat`:

- `session` (required): session scoped to the active session token
- `id` (optional): reset key for when you swap sessions; defaults to `session.id`
- `userMessageSource` (optional, default `"use-chat"`): source string for user append events
- `onError` (optional): callback for append, projection, or surfaced session `error` events
- Returns `{ messages, sendMessage, status }`

## Behavior

- Uses the session's current materialized event view as the durable source of truth for chat state.
- Refreshes from live `session.on("event", ..., { replay: false })` updates and only consumes:
  - `chat.user.message`
  - `chat.assistant.chunk`
- Appends outgoing user messages as strict chat envelopes.
- `sendMessage(...)` performs the durable append and expects backend `.on(...)` handlers to react.
- When backed by `StarciteSession`, transient append transport failures are retried in-order instead of failing fast.
- Terminal append failures pause the SDK outbox by default; inspect `session.appendState()` and use `session.resumeAppendQueue()` or `session.resetAppendQueue()` for operational recovery.
- When the underlying `StarciteSession` is configured with `refreshToken`, session-token renewal stays internal to the SDK and retained events remain the source of truth.
- Rebuilds `UIMessage[]` from durable events whenever new chat events arrive.

## Exports

- `useStarciteSession`
- `UseStarciteSessionOptions`
- `UseStarciteSessionResult`
- `StarciteSessionLike`
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
