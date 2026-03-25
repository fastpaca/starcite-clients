# AI SDK To Starcite Migration Instructions

This document is for coding agents and LLMs.

Use it when migrating an app from AI SDK request/response chat transport to
Starcite session transport.

## Goal

Convert the app from:

- browser sends `messages[]` to a backend route
- backend streams the assistant response directly over HTTP

To:

- browser appends a durable user event to a Starcite session
- backend reacts to Starcite lifecycle/session events
- backend appends assistant chunks back into the same session
- UI renders from the Starcite session timeline

## Core Rule

Do not keep the traditional AI SDK request/response transport model as the
default path.

For the default Starcite migration:

- `sendMessage(...)` should append to the session
- the backend should react via `.on(...)` handlers
- the browser should not manually trigger model execution after each append

## Public Model

Use these public primitives:

- `starcite.on("session.created", ...)` for tenant-scoped lifecycle events
- `session.on("event", ...)` for session events
- `session.events()` for current canonical session history
- `session.append(...)` for durable writes

Do not introduce a separate runtime/framework abstraction in user-facing code.

## Default Migration Pattern

### Frontend

Replace:

```tsx
const { messages, sendMessage, status } = useChat({
  api: "/api/chat",
});
```

With:

```tsx
const { messages, sendMessage, status } = useStarciteChat({
  session,
  id: session.id,
});
```

`sendMessage(...)` must durably append the user message to Starcite.

Do not add a follow-up browser fetch to trigger the assistant in the default
path.

### Backend

Create one long-lived backend `Starcite` client:

```ts
const starcite = new Starcite({
  apiKey: process.env.STARCITE_API_KEY!,
  baseUrl: process.env.STARCITE_BASE_URL || "https://api.starcite.io",
});

const agentIdentity = starcite.agent({
  id: process.env.STARCITE_AGENT_ID || "assistant",
});
```

Start one lifecycle listener:

```ts
starcite.on("session.created", (event) => {
  void ensureSessionAttached(event.session_id);
});
```

Attach each session once:

```ts
async function ensureSessionAttached(sessionId: string): Promise<void> {
  const session = await starcite.session({
    identity: agentIdentity,
    id: sessionId,
  });

  session.on("event", (event, context) => {
    if (context.replayed || event.type !== "chat.user.message") {
      return;
    }

    void respondToUserMessage(session);
  });
}
```

Run AI SDK from the session timeline:

```ts
async function respondToUserMessage(session: StarciteSession): Promise<void> {
  const messages = await toUIMessagesFromEvents(session.events());
  if (messages.length === 0) {
    return;
  }

  const result = streamText({
    model,
    messages: convertToModelMessages(messages),
  });

  for await (const chunk of result.toUIMessageStream()) {
    await appendAssistantChunkEvent(session, chunk, {
      source: "openai",
    });
  }
}
```

## Backend Rewiring Rules

When migrating an existing AI SDK backend route:

- stop reading `messages[]` from the browser request as the primary model input
- read the session history from `session.events()` instead
- keep the model/tool/business logic from the old route
- move assistant output persistence into `appendAssistantChunkEvent(...)`
- move orchestration from browser-triggered fetches to backend `.on(...)`
  handlers

The backend still owns:

- auth
- model choice
- tools
- system prompt
- app-specific business logic

The thing that changes is the transport/substrate, not the model logic.

## Session Bootstrap Rule

The browser still needs a session token route.

Use the bootstrap route to:

1. create or reuse the user session
2. return `{ token, sessionId }`
3. call `ensureSessionAttached(session.id)` before returning

That third step matters because lifecycle is currently live-only.

## Current Limitation

Right now `starcite.on("session.created", ...)` is live-only.

Implication:

- if the backend restarts, it will not replay already-existing sessions from a
  lifecycle cursor yet

Current workaround:

- when issuing a session token, also call `ensureSessionAttached(session.id)`

This is the correct migration pattern until lifecycle replay/cursor support is
added.

## Anti-Patterns

Do not do these in the default migration:

- do not keep `useChat({ api })` as the main frontend model
- do not make the browser orchestrate model execution after every append
- do not use browser-triggered request fallbacks as part of the recommended integration
- do not keep the assistant response as a special HTTP stream outside Starcite
- do not rebuild the backend around a new public runtime/framework abstraction
- do not treat Starcite as a mirror of the old request/response transport

## Short Prompt Context For Another LLM

Use this exact framing:

- Migrate AI SDK chat from request/response transport to Starcite session transport.
- Frontend uses `useStarciteChat({ session })`.
- `sendMessage(...)` durably appends the user message.
- Backend listens with `starcite.on("session.created", ...)`.
- Backend attaches `session.on("event", ...)`.
- On live `chat.user.message`, backend reads `session.events()`, runs
  `streamText(...)`, and appends assistant chunks back into the same session.
- Session bootstrap route must also call `ensureSessionAttached(session.id)`
  because lifecycle is live-only right now.

## Reference Implementation In This Repo

- `examples/nextjs-chat-ui/app/api/starcite/session/route.ts`
- `examples/nextjs-chat-ui/app/page.tsx`
- `packages/starcite-react/src/use-starcite-chat.ts`
- `packages/starcite-react/src/chat-protocol.ts`
- `packages/typescript-sdk/src/client.ts`
