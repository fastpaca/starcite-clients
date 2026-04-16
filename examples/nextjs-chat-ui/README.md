# Next.js Chat UI Example

Minimal Next.js App Router demo for durable chat streaming.
The example is intentionally small and reads like a `useChat` replacement tutorial.

It shows:

- `useStarciteChat` from `@starcite/react`
- server-side session creation with `@starcite/sdk`
- lifecycle-driven AI SDK response handling with `streamText` from `ai`
- off-the-shelf AI Elements UI primitives for conversation/input

## Run

From the repo root:

```bash
bun install

# edit this first
cp examples/nextjs-chat-ui/.env.example examples/nextjs-chat-ui/.env.local

bun run --cwd examples/nextjs-chat-ui dev
```

Open `http://localhost:3000`.

## How it works

1. Browser reads `?sessionId=<id>`.
2. Browser requests `/api/starcite/session` with optional `sessionId`.
3. Route handler creates/reuses the user session and returns `{ token, sessionId }`.
4. Client writes the returned `sessionId` to the query param.
5. Client builds a session from the token and calls `useStarciteChat({ session, id: sessionId })`.
6. `sendMessage(...)` durably appends the user event to Starcite.
7. A server-only module imported by `app/layout.tsx` listens for `session.created` with `starcite.on(...)`, treats this single demo agent as the owner of every new session, then binds those sessions with `starcite.session({ identity, id })`.
8. When a live `chat.user.message` event arrives, that listener reads `session.range(1, sessionEvent.seq)`, runs `streamText(...)`, and appends assistant chunks back into the same session.
9. The hook updates from durable `session.on("event")` events as the assistant chunks arrive.

The example uses an exact seq-bounded read on purpose. Chat output is stored as assistant chunk events, so the server reconstructs prior turns through the triggering user event's `seq`, which includes completed conversation state without pulling in the response it is about to generate.

## Current limitation

`session.created` is live-only today. This demo therefore attaches responders only for
sessions created while the server process is running.

## Manual durability checks

1. Cold load with an existing `sessionId`: prior conversation state should render after connect.
2. Send a new message in an existing session: status transitions (`submitted`/`streaming`/`ready`) and assistant output should stream in-place.
3. Reload or reopen the page with the same `sessionId`: previously completed conversation state should still render.
