# Frontend Chat State

Use this when migrating the browser UI from local/transient chat state onto a
durable Starcite session timeline.

## Goal

The frontend should:

1. create `const session = starcite.session({ token })`
2. render from durable session state
3. append user messages to the session

## Required Behavior

Reference shape:

```tsx
const session = starcite.session({ token });

const { messages, sendMessage, status } = useStarciteChat({
  session,
  id: session.id,
});
```

`sendMessage(...)` must:

- append the user message durably
- not manually trigger backend execution

## Preserve

Preserve the app's existing:

- message components
- layout
- input controls
- product copy

## Change

Replace frontend-managed transcript state or HTTP-stream-driven assistant state
with Starcite-backed session state.

The session timeline is canonical.

## Anti-Patterns

Do not:

- treat browser memory as canonical chat history
- render from a separate HTTP response stream
- append in one request and trigger the backend in a second request

## References

- `docs/ai-sdk-migration.md`
- `packages/starcite-react/src/use-starcite-chat.ts`
- `examples/nextjs-chat-ui/app/page.tsx`
