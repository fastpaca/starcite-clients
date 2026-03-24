# AI SDK Paved Path: `StarciteSession` Behavior Spec

## Summary

The AI SDK paved path should not introduce a new public runtime or framework
abstraction.

The existing `StarciteSession` surface already has the right concepts:

- `session.append(...)`
- `session.events()`
- `session.on(...)`

The problem is that these methods currently behave like low-level stream/log
primitives, not like a managed session mirror that application developers can
reason about simply.

This spec defines the behavioral contract changes required to make
`StarciteSession` usable as a low-friction backend and frontend primitive for
AI SDK applications.

## Problem

For AI SDK users, the desired migration should be small:

1. Add session token bootstrap.
2. Swap `useChat` for `useStarciteChat`.
3. Patch the existing backend route to read/write via Starcite.
4. Done.

That migration is currently harder than it should be because `StarciteSession`
does not behave the way users expect:

- `session.events()` is only the retained in-memory snapshot, not "current
  session history".
- `session.on(...)` implicitly owns replay/live sync lifecycle and exposes that
  complexity to the caller.
- `session.append(...)` acknowledges durability, but does not guarantee that the
  local session view has incorporated the write when the promise resolves.

This forces backend users to reason about:

- keeping sessions warm in-process
- replay vs live semantics
- catch-up passes
- reconnect/gap recovery
- token expiry
- whether they can trust `events()` inside a request

That is the real AI SDK onboarding problem.

## Goals

- Keep the public mental model centered on `StarciteSession`.
- Avoid introducing a new public "runtime", "chat manager", or route factory.
- Make `append`, `events`, and `on` behave the way application developers
  expect.
- Hide backend session stream lifecycle management inside the SDK.
- Preserve low-level escape hatches for advanced users.
- Make AI SDK backend integration possible in a normal request handler without
  manually managing session mirrors.

## Non-Goals

- Replacing application-owned backend endpoints.
- Replacing `streamText(...)`, tools, or model selection.
- Replacing app-specific auth, request parsing, or business logic.
- Designing a new general-purpose "chat framework" on top of Starcite.
- Renaming all AI SDK-specific protocol helpers as part of this change.

## User Model

The user model we want is:

- `session.append(...)` means: "write this durably and my local view reflects
  that write."
- `session.events()` means: "give me the current canonical session snapshot."
- `session.on("event", ...)` means: "subscribe to ordered canonical updates."

The user should not need to think about:

- whether the session is warm or cold
- whether a replay pass has completed
- whether live sync is active
- whether they need to explicitly start a subscription before `events()` is
  trustworthy
- whether their own append will show up in the local snapshot

## Current Behavior

Today, the underlying behavior is roughly:

- `events()` returns whatever is currently retained in memory.
- `on("event")` starts and maintains hidden live sync.
- `append()` durably writes, but local log advancement depends on separate tail
  machinery catching up.

This is internally coherent, but externally surprising.

## Method Contract Delta

This change does not require a new public API surface. It requires a stricter
contract for the existing methods.

### `session.append(...)`

Current effective contract:

- "The server durably accepted this append."
- "Your local session view may reflect it later if sync machinery catches up."

New required contract:

- "The server durably accepted this append."
- "The managed local mirror has advanced through this append before the promise
  resolves."

Implementation requirement:

- The append path must reconcile the acknowledged write into the managed mirror
  before resolving to user code.
- That reconciliation may be optimistic or catch-up based, but it must be
  canonical from the perspective of `events()` and `on(...)`.

### `session.events()`

Current effective contract:

- "Return the events currently retained in memory."

New required contract:

- "Return the current canonical snapshot of this session's managed mirror."

Implementation requirement:

- Session acquisition must attach to a managed mirror and hydrate it enough that
  `events()` is trustworthy without a prior subscription.
- Hidden catch-up remains the SDK's job, not the application's.

### `session.on("event", ...)`

Current effective contract:

- "Subscribe to a transport-driven stream that also bootstraps live sync."

New required contract:

- "Subscribe to ordered updates from the managed canonical mirror."

Implementation requirement:

- Listener delivery must be sourced from the mirror, not directly from the wire.
- Replay, reconnect, and local append reconciliation must all be merged before
  fanout reaches user listeners.

## Desired Behavior

`StarciteSession` should become a managed canonical mirror of a remote session.

### `session.append(...)`

Desired contract:

- When `append()` resolves successfully, the session's managed mirror has
  incorporated that append.
- A subsequent `session.events()` call must include the appended event.
- Active `session.on("event")` subscribers must observe the appended event
  exactly once in canonical order.
- The caller must not need to run a separate `on(...)` subscription just to see
  their own write reflected locally.

Implications:

- Append acknowledgement and local mirror reconciliation must be coupled.
- The SDK may satisfy this by:
  - synthesizing a canonical local event and reconciling later, or
  - performing a hidden catch-up pass to at least the acknowledged sequence.
- The chosen implementation is less important than the behavioral contract:
  `append()` resolution means the local mirror is coherent.

### `session.events()`

Desired contract:

- `events()` returns the current canonical snapshot of the managed session
  mirror.
- Callers can trust it as the read model for request-scoped work.
- It should not require the caller to have previously called `on(...)`.

Implications:

- Backend identity-bound session acquisition must hydrate/catch up before the
  session is returned, or otherwise guarantee that the first `events()` read is
  coherent.
- Token-bound browser sessions may still start empty momentarily, but the SDK
  should begin hidden hydration automatically and not require an explicit
  subscription to become useful.
- `events()` remains synchronous as a snapshot read, but the SDK owns the
  responsibility of keeping that snapshot meaningful.

### `session.on("event", ...)`

Desired contract:

- `on("event")` subscribes to the managed canonical mirror, not directly to the
  wire protocol.
- By default, the listener receives one ordered event stream covering current
  retained history and subsequent live updates.
- Replay/live distinctions remain an advanced concern, not a requirement for
  normal usage.

Implications:

- Replay, catch-up, reconnect, and gap recovery stay inside the SDK.
- The existing `context.replayed` / `phase` semantics may remain for advanced
  users, but callers should not need to branch on them for standard chat
  workflows.
- Listener ordering and exactly-once local delivery semantics must be preserved.

## Required Internal Changes

### 1. Managed Session Lifecycle Inside the SDK

The SDK should manage session lifecycles internally.

This likely requires a process-local session manager inside `Starcite` or
`StarciteSession` internals that:

- reuses warm managed mirrors for repeated acquisition of the same session
- keys reuse by session identity and session id
- keeps active sessions synchronized
- evicts idle sessions after a TTL
- hides cold-start catch-up behavior

This manager is an implementation detail, not a public API.

### 1a. Activity Should Be Interest-Based, Not Handle-Based

The registry should not treat a session as "active" merely because a
`StarciteSession` handle exists in user code.

Instead, a managed mirror is active only while at least one of these is true:

- it has one or more `on("event")` subscribers
- it has one or more active `tail()` consumers
- it has an in-flight hydration or catch-up pass
- it has an `append()` waiting for reconciliation through an acknowledged seq
- it is within a short keep-warm grace period after recent activity

This distinction matters because a request-scoped backend handler may acquire a
session, read `events()`, and finish quickly. That should not imply a permanent
live watcher just because the handle still exists in memory briefly.

### 1b. Separate "Stop Following" From "Evict"

The lifecycle manager should make two separate decisions:

- when to stop consuming live events for a mirror
- when to evict that mirror from the in-process registry entirely

Required behavior:

- When live interest drops to zero, the manager may keep the mirror warm for a
  short cooldown window to avoid reconnect thrash.
- After the cooldown window expires, the manager should stop the live watcher
  and leave the mirror idle with its last coherent snapshot retained.
- After a longer idle TTL, the manager may evict the mirror from memory.
- Persisted state may remain even after eviction.

This allows backend request handlers to remain cheap while still giving frontend
subscribers and bursty backend traffic a warm path.

The cooldown window, idle eviction TTL, and backend identity-acquisition
hydration policy should be configurable as part of `Starcite` client
initialization. They are runtime policy settings, not per-session behavioral
knobs.

### 1c. Recommended Internal States

The exact implementation is flexible, but the lifecycle should behave like a
small state machine:

- `idle`: retained snapshot exists, no live watcher
- `hydrating`: catch-up in progress
- `following`: live tail active
- `cooldown`: no current live interest, but watcher temporarily retained
- `evicted`: mirror removed from the active registry

The important requirement is not the state names. It is that the SDK can stop
consuming events when there is no live interest, without losing the ability to
reacquire a coherent mirror later.

### 2. Session Acquisition Must Produce a Usable Mirror

For backend identity-bound sessions:

```ts
const session = await starcite.session({
  identity: starcite.agent({ id: "assistant" }),
  id: sessionId,
});
```

The returned session should be usable immediately as a read model.

Specifically:

- `session.events()` should be trustworthy immediately after acquisition.
- The caller should not need to set up `session.on(...)` just to warm it.

This is the key behavior needed for AI SDK request handlers.

An incremental delivery path is acceptable here:

- the SDK may expose strict backend acquisition as a client-level lifecycle
  policy before making it the default
- newly created empty sessions do not need to pay for a redundant catch-up pass
  if the server already reported `last_seq: 0`

### 3. Automatic Hidden Synchronization

The SDK should decide when to:

- perform initial catch-up
- keep a session warm
- reconnect
- recover from gaps

These should be hidden implementation details.

The session should behave like a maintained mirror, not like a dormant wrapper
around a transport.

### 4. Append Reconciliation

After a successful append:

- local mirror state must advance
- subscribers must be notified in order
- `events()` must reflect the write

This is a strict behavioral requirement. Without it, AI SDK integrations cannot
reason locally about session state after writes.

### 5. Token Refresh / Rebind

Managed sessions should hide token churn where possible.

At minimum:

- browser bootstrap continues to mint a user session token
- backend identity-bound acquisition can remint/rebind internally as needed
- token expiry should not force application code to manually rebuild the session
  mirror

### 6. Ordered Fanout to Subscribers

All subscriber callbacks must observe one ordered canonical event stream for the
local mirror.

The user should never have to merge:

- replay events
- live tail events
- their own local writes

That merge must happen inside the SDK.

## Internal Architecture Constraints

The implementation should preserve the existing session-centric mental model
while changing where coordination happens.

Constraints:

- The unit of coordination is a managed mirror, even if the public API remains
  `StarciteSession`.
- Session mirror management should be internal to the SDK, not app-owned.
- Multiple acquisitions of the same backend identity/session pair in one process
  should reuse coordination state where possible.
- Request handlers should be able to treat `await starcite.session(...)` as
  "get me a coherent session handle now", not "construct a wrapper and start
  wiring it up yourself."
- Advanced stream/log consumers can still opt into lower-level behavior, but the
  default session path should no longer feel transport-shaped.
- `disconnect()` / `close()` should release this handle's interest in the
  mirror, not unconditionally tear down shared mirror state used by other
  handles.

## AI SDK-Specific Helpers

The current protocol helpers are AI SDK-specific and can remain helpers:

- `appendAssistantChunkEvent(...)`
- `appendUserMessageEvent(...)`
- `toUIMessagesFromEvents(...)`

They are somewhat clunky, but naming is secondary.

The primary problem is not helper naming. The primary problem is that
`StarciteSession` itself does not yet behave like a managed session mirror.

Once the underlying session behavior is fixed, these helpers become much easier
to use in a straightforward request handler:

```ts
const session = await starcite.session({
  identity: starcite.agent({ id: "assistant" }),
  id: sessionId,
});

const messages = await toUIMessagesFromEvents(session.events());

const result = streamText({
  model,
  messages: convertToModelMessages(messages),
});

for await (const chunk of result.toUIMessageStream()) {
  await appendAssistantChunkEvent(
    session,
    chunk as Record<string, unknown>
  );
}
```

No public runtime abstraction is required if the session semantics are correct.

## AI SDK Before / After

### Before

Frontend:

```tsx
const { messages, sendMessage, status } = useChat({
  api: "/api/chat",
});
```

Backend:

```ts
export async function POST(req: Request) {
  const { messages, ...input } = await req.json();

  const result = streamText({
    model,
    messages: convertToModelMessages(messages),
    ...input,
  });

  return result.toUIMessageStreamResponse();
}
```

### After

Frontend:

```tsx
const { messages, sendMessage, status } = useStarciteChat({
  session,
});
```

Backend:

```ts
export async function runAgentTurn(sessionId: string, input: Input) {
  const session = await starcite.session({
    identity: starcite.agent({ id: "assistant" }),
    id: sessionId,
  });

  const messages = await toUIMessagesFromEvents(session.events());

  const result = streamText({
    model,
    messages: convertToModelMessages(messages),
    ...input,
  });

  for await (const chunk of result.toUIMessageStream()) {
    await appendAssistantChunkEvent(
      session,
      chunk as Record<string, unknown>
    );
  }
}
```

The migration remains plug-in shaped:

1. Add session token bootstrap.
2. Swap `useChat` for `useStarciteChat`.
3. Change the backend route or worker to read/write via the managed session.

How backend execution is triggered after a user message is explicitly
application-owned and not part of this spec.

## Acceptance Criteria

The change is successful when all of the following are true:

- A backend request handler can call `await starcite.session({ identity, id })`
  and immediately trust `session.events()`.
- A successful `session.append(...)` is reflected in `session.events()` before
  the promise resolves.
- A normal application never needs to manually manage session warmness, replay
  passes, reconnects, or token refresh to use `append`, `events`, and `on`.
- `useStarciteChat` plus a patched AI SDK backend path is enough for the common
  migration path.
- No new public runtime/framework abstraction is required.

## Open Questions

- Should backend identity-bound session acquisition block on full catch-up, or
  only on catch-up through the latest known server cursor at acquisition time?
- For token-bound browser sessions, should hidden hydration start immediately on
  construction or lazily on first usage?
- Should append reconciliation synthesize local canonical events or force a
  hidden catch-up through the acknowledged sequence?
- How should process-local session mirror eviction be tuned for memory usage vs
  warm-start latency?
