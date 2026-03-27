# Backend Session Listener

Use this when migrating backend response handling from request/response
streaming onto Starcite lifecycle and session events.

## Goal

The backend should:

1. keep one long-lived server `Starcite` client
2. discover sessions with `starcite.on("session.created", ...)`
3. decide whether a given agent owns that session
4. bind the session explicitly as the agent identity
5. listen on `session.on("event", ...)`
6. append assistant output back into the same session

## Required Behavior

Reference shape:

```ts
const starcite = new Starcite({ apiKey, baseUrl });
const agent = starcite.agent({ id: "assistant" });

starcite.on("session.created", (event) => {
  if (!shouldHandleSession(event)) {
    return;
  }

  void (async () => {
    const session = await starcite.session({
      identity: agent,
      id: event.session_id,
    });

    session.on("event", async (sessionEvent, context) => {
      if (context.replayed || !isUserMessage(sessionEvent)) {
        return;
      }

      const messages = await toUIMessagesFromEvents(session.events());
      const result = streamText({ model, messages: convertToModelMessages(messages) });

      for await (const chunk of result.toUIMessageStream()) {
        await appendAssistantChunkEvent(session, chunk, { source: "openai" });
      }
    });
  })();
});
```

## Preserve

Preserve the app's existing:

- prompts
- tool definitions
- model choices
- business logic
- session ownership decisions

## Change

Replace:

- request transcript parsing
- HTTP response streaming as the UI transport

With:

- `session.events()` as input history
- `session.append(...)` / `appendAssistantChunkEvent(...)` as output transport

## Current Constraint

Lifecycle discovery is currently live-only.

That means:

- new sessions are discovered automatically
- sessions created before backend startup are not replayed automatically

## Anti-Patterns

Do not:

- return `toUIMessageStreamResponse()` as the main UI transport
- keep assistant output outside the session timeline
- register backend listeners from the session bootstrap route

## References

- `docs/ai-sdk-migration.md`
- `examples/nextjs-chat-ui/lib/agent.ts`
- `packages/starcite-react/src/chat-protocol.ts`
