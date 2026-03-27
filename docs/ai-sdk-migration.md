# AI SDK To Starcite Migration Spec

This document defines the migration model for moving an existing AI SDK app
onto Starcite.

It is a specification for how the migrated system should work. It is not a
tutorial and not a standalone prompt.

## 1. Identity Model

Starcite has two relevant identity roles in this migration:

- user identity
- agent identity

User identity:

- represents the human/app user in a session
- is used by the backend to mint a frontend session token
- is the identity the browser uses when appending user messages

Agent identity:

- represents the backend responder
- is used by the backend to bind owned sessions
- is the identity the backend uses when appending assistant output

Rules:

- frontend code should only ever receive a session token
- frontend code should never receive the Starcite API key
- frontend code should never bind as the agent identity
- backend code should explicitly choose which identity binds a session

## 2. Frontend Tokens

Frontend chat state is session-scoped. The browser needs a session token, not
an API key.

The backend must mint a session token for the frontend.

The bootstrap route must:

1. create or reuse a session for the user
2. bind that session as the user identity
3. return `{ token, sessionId }`

The frontend must then:

```ts
const session = starcite.session({ token });
```

Why:

- the browser only needs session-scoped read/append access
- the browser should not hold tenant-wide backend credentials
- the browser should interact with Starcite directly for durable chat state

## 3. Session Renewal

Session tokens are frontend credentials and may expire.

The frontend must be able to reacquire a fresh `{ token, sessionId }` pair for
an existing session.

Required model:

1. keep the current `sessionId`
2. call the bootstrap route again with that `sessionId`
3. receive a fresh session token for the same session
4. recreate `starcite.session({ token })` on the frontend

Implications:

- token renewal is a normal backend responsibility
- the browser should never try to refresh with the API key
- session renewal should reuse the same session when possible

## 4. Protocol Model

Starcite is not request/response chat transport.

Do not model the system as:

1. browser sends transcript to backend
2. backend returns assistant stream over HTTP
3. browser renders from that HTTP stream

The required Starcite model is:

1. frontend appends a durable user message to a Starcite session
2. backend discovers sessions from lifecycle events
3. application code decides which agent owns a session
4. backend binds owned sessions explicitly with `starcite.session({ identity, id })`
5. backend listens to live session events with `session.on("event", ...)`
6. backend appends assistant chunks back into the same session
7. frontend renders from the session timeline with `session.events()` + `session.on("event")`

These responsibilities must stay distinct:

- `starcite.on(...)` is lifecycle discovery
- `starcite.session(...)` is explicit identity binding
- `session.on(...)` is per-session event handling
- `session.events()` is the canonical session read model

## 5. Frontend Migration

Frontend must:

1. fetch `{ token, sessionId }` from a bootstrap route
2. create `const session = starcite.session({ token })`
3. use `useStarciteChat({ session, id: session.id })`
4. call `sendMessage(...)`

Reference shape:

```tsx
const session = starcite.session({ token });

const { messages, sendMessage, status } = useStarciteChat({
  session,
  id: session.id,
});
```

Frontend behavior requirements:

- `sendMessage(...)` must only durably append the user message
- frontend must render from Starcite session state
- frontend must not manually trigger backend execution after append
- frontend may keep local UI state for layout, input, or interaction, but the
  session timeline is the canonical chat history

## 6. Backend Migration

Backend must use one long-lived `Starcite` client:

```ts
const starcite = new Starcite({
  apiKey: process.env.STARCITE_API_KEY!,
  baseUrl: process.env.STARCITE_BASE_URL || "https://api.starcite.io",
});
```

Backend must use lifecycle events for session discovery:

```ts
starcite.on("session.created", (event) => {
  if (!shouldHandleSession(event)) {
    return;
  }

  void attachOwnedSession(event.session_id);
});
```

Backend must explicitly bind owned sessions as the responding identity:

```ts
const agent = starcite.agent({ id: "assistant" });

async function attachOwnedSession(sessionId: string): Promise<void> {
  const session = await starcite.session({
    identity: agent,
    id: sessionId,
  });

  session.on("event", (event, context) => {
    if (context.replayed || event.type !== "chat.user.message") {
      return;
    }

    void respond(session);
  });
}
```

Backend must use the session timeline as model input:

```ts
async function respond(session: StarciteSession): Promise<void> {
  const messages = await toUIMessagesFromEvents(session.events());

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

Backend behavior requirements:

- preserve existing model/tool/prompt/business logic
- change only the transport/orchestration substrate
- use `session.events()` as the canonical chat history
- append assistant output back into Starcite instead of returning it as the UI transport
- keep demo/server code direct: stream with AI SDK and append deltas directly to the session

## 7. Ownership And Routing

Lifecycle discovery is not ownership.

The application must decide:

- whether an agent should handle a session
- which identity should bind to that session
- whether the session should be ignored

Never assume every agent handles every session.

For a single-agent demo, ownership can be simplified to “all sessions”.

For a real app, inspect the existing routing/assignment logic first.

## 8. Current Constraints

Current lifecycle behavior:

- `session.created` is live-only
- sessions created before backend startup are not rediscovered automatically

Implications:

- bootstrap routes should create or reuse sessions and return `{ token, sessionId }`
- bootstrap routes should not be used to perform backend orchestration
- lifecycle replay/cursor support is the future fix for pre-existing session discovery

## 9. Anti-Patterns

Do not implement any of these patterns:

- browser appends a message and then separately triggers backend execution
- browser transcript is treated as canonical backend history
- backend returns `toUIMessageStreamResponse()` to drive the UI
- assistant output is kept outside Starcite as a special HTTP stream
- bootstrap/session-token route is used to perform backend orchestration
- session token issuance is combined with listener registration or agent startup
- public worker/runtime/framework abstractions are introduced on top of Starcite
- every agent is attached to every session by default
- simple AI SDK streaming is wrapped in extra batching/accumulation helpers in the demo path

## 10. Multi-Agent Sessions

Multi-agent apps should still use the same shared-session model.

Required model:

- each backend agent binds the same `sessionId`
- each backend agent uses its own agent identity
- all agent output is appended into the same session timeline
- the frontend renders that shared session instead of opening separate streams

Preserve the app's existing:

- orchestration logic
- tool calls
- agent roles
- model choices

Do not:

- build separate browser transport channels per agent
- parse natural-language coordinator output as orchestration state
- hide shared-session behavior behind extra runtime abstractions in the demo path

## 11. Required Public Surface

The migration should use these public APIs:

- `starcite.on("session.created", ...)`
- `starcite.session({ identity, id })`
- `session.on("event", ...)`
- `session.events()`
- `session.append(...)`
- `useStarciteChat({ session, id? })`

## 12. References

Starcite server code:

- `https://github.com/fastpaca/starcite`

Client SDK code in this repo:

- `packages/typescript-sdk/src/client.ts`
- `packages/typescript-sdk/src/lifecycle-runtime.ts`
- `packages/typescript-sdk/src/session.ts`
- `packages/starcite-react/src/use-starcite-chat.ts`
- `packages/starcite-react/src/chat-protocol.ts`

Reference implementation in this repo:

- `examples/nextjs-chat-ui/app/api/starcite/session/route.ts`
- `examples/nextjs-chat-ui/app/page.tsx`
- `examples/multi-agent-viewer/lib/agent.ts`
