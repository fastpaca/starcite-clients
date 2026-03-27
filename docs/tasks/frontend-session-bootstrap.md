# Frontend Session Bootstrap

Use this when the app needs to mint a browser-safe Starcite session token.

## Goal

Create or reuse a session for the user identity and return:

- `token`
- `sessionId`

## Required Behavior

The bootstrap endpoint must:

1. run on the backend
2. bind or create the session as the user identity
3. return only session-scoped frontend credentials

The frontend must never receive:

- the Starcite API key
- an agent identity binding

## Preserve

Preserve the app's existing:

- user authentication
- tenant lookup
- routing
- request shape, if there is a strong reason to keep it

## Change

Replace any existing ad hoc frontend credential minting with a Starcite session
token response.

Reference shape:

```ts
const user = starcite.user({ id: appUserId });

const session = await starcite.session({
  identity: user,
  id: existingSessionId,
});

return { token: session.token, sessionId: session.id };
```

## Anti-Patterns

Do not:

- start backend agents from the bootstrap route
- register `starcite.on(...)` listeners from the bootstrap route
- combine token issuance with backend orchestration

## References

- `docs/ai-sdk-migration.md`
- `examples/nextjs-chat-ui/app/api/starcite/session/route.ts`
