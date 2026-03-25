# Prompt Reference: Rewiring An AI SDK App Onto Starcite

Use this file as prompt context for a coding agent or LLM during onboarding.
It is not a human tutorial. Write code that follows these rules.

## Task

You are rewiring an existing app that already uses AI SDK in some form onto
Starcite.

Do not assume:

- the app uses `useChat`
- the app has a single `/api/chat` route
- the app streams assistant output directly from one obvious backend endpoint

First inspect the actual frontend and backend. Then apply the rules below.

## What Stays The Same

The app can keep:

- AI SDK model calls like `streamText(...)`
- tool definitions
- system prompts
- auth and business logic
- app-specific request parsing

Do not rewrite the app around a new framework abstraction.

## What Must Change

Move the app from request/response chat transport onto Starcite session
transport.

Target model:

- frontend appends durable user events to a Starcite session
- backend discovers sessions with Starcite lifecycle events
- app code decides which agent owns which sessions
- owned sessions are bound explicitly with `starcite.session({ identity, id })`
- backend appends assistant chunks back into those same sessions
- frontend renders from `session.events()` + `session.on("event")`

## Public Primitives To Use

Use these public APIs:

- `starcite.on("session.created", ...)`
- `session.on("event", ...)`
- `session.events()`
- `session.append(...)`
- `useStarciteChat({ session, id? })`

The SDK handles the per-session stream lifecycle after a session has been
bound.

## Hard Rules

- Do not make the browser manually trigger model execution after `sendMessage(...)`.
- Do not keep the assistant response outside Starcite as a special HTTP stream.
- Do not read the browser transcript as the canonical backend history.
- Do not introduce a public runtime/framework layer on top of Starcite.
- Do not assume every agent responds to every session.

## Frontend Transformation

### Required shape

The frontend should:

1. fetch a Starcite session token from a bootstrap route
2. create `const session = starcite.session({ token })`
3. call `useStarciteChat({ session, id: session.id })`
4. use `sendMessage(...)`

### Required behavior

`sendMessage(...)` should:

- append the user message to Starcite
- not call a separate backend chat route

### Example target

```tsx
const { messages, sendMessage, status } = useStarciteChat({
  session,
  id: session.id,
});
```

## Backend Transformation

### Required shape

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

Register one lifecycle listener at module scope:

```ts
starcite.on("session.created", (event) => {
  if (!shouldHandleSession(event)) {
    return;
  }

  void attachOwnedSession(event.session_id);
});
```

Bind only sessions that this agent should own:

```ts
async function attachOwnedSession(sessionId: string): Promise<void> {
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

Generate the assistant response from session history:

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

## Ownership Rule

Do not assume a lifecycle event means "respond to this session now".

`starcite.on("session.created", ...)` is discovery. Your app must still decide:

- which sessions this agent should own
- which identity to bind as
- whether some sessions should be ignored entirely

In a single-agent demo, `shouldHandleSession(...)` can always return `true`.
In a real app, inspect metadata, routing, or the existing ownership logic first.

## Session Bootstrap Rule

The app still needs a session bootstrap/token route.

That route should:

1. create or reuse the user session
2. return `{ token, sessionId }`

Do not use the bootstrap route to smuggle backend orchestration logic into the
browser happy path.

Current limitation:

- `starcite.on("session.created", ...)` is live-only today
- sessions created before backend startup are not rediscovered automatically yet
- lifecycle replay/cursor support should solve this later

## What To Look For In The Existing App

When inspecting the app before migrating it, identify:

- where the browser currently sends messages
- where the backend currently calls `streamText(...)`
- where AI SDK chunks currently go
- whether the backend already has a long-lived process/module scope

Then move only the transport/orchestration pieces onto Starcite.

Keep the model logic.

## Anti-Patterns To Remove

If the app currently does any of these, remove them from the paved path:

- browser sends `messages[]` as the canonical source of truth
- browser calls `sendMessage(...)` and then separately POSTs to trigger the model
- backend returns `toUIMessageStreamResponse()` directly to drive the UI
- frontend renders from special route responses instead of Starcite events
- backend blindly attaches every agent to every session

## Short Prompt Snippet

If you need to give another LLM minimal instructions, use this:

- Inspect the current AI SDK app first; do not assume `useChat` or a specific route shape.
- Move chat transport onto Starcite sessions.
- Frontend uses `useStarciteChat({ session })`.
- `sendMessage(...)` durably appends the user message only.
- Backend listens with `starcite.on("session.created", ...)` to discover sessions.
- App code decides whether the current agent should handle that session.
- Owned sessions are bound explicitly with `starcite.session({ identity, id })`.
- After binding, attach `session.on("event", ...)`.
- On live `chat.user.message`, backend reads `session.events()`, runs
  `streamText(...)`, and appends assistant chunks back into the same session.
- Keep backend orchestration out of the browser/bootstrap path.
- Today `session.created` is live-only, so pre-existing sessions are not auto-rediscovered after backend restart.
- Do not add browser-triggered request fallback code.

## Reference Implementation In This Repo

- `examples/nextjs-chat-ui/app/api/starcite/session/route.ts`
- `examples/nextjs-chat-ui/app/page.tsx`
- `packages/starcite-react/src/use-starcite-chat.ts`
- `packages/starcite-react/src/chat-protocol.ts`
- `packages/typescript-sdk/src/client.ts`
