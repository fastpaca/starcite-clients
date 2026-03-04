# Next.js Chat UI Example

Minimal Next.js App Router demo for durable chat streaming.
The example is intentionally small and reads like a `useChat` replacement tutorial.

It shows:

- `useStarciteChat` from `@starcite/react`
- server-side session creation with `@starcite/sdk`
- server-side agent consumption with `streamText` from `ai`
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
3. Route handler creates/reuses the session, registers `agent.ts`, and returns `{ token, sessionId }`.
4. Client writes the returned `sessionId` to the query param.
5. Client builds a session from the token and calls `useStarciteChat({ session, id: sessionId })`.
6. Hook reads durable `session.events()` and updates on new `session.on("event")` events.

## Manual durability checks

1. Cold load with an existing `sessionId`: full history should render after connect.
2. Send a new message in an existing session: status transitions (`submitted`/`streaming`/`ready`) and assistant output should stream in-place.
3. Start a longer response, refresh mid-stream, keep same `sessionId`: stream should continue and finish without losing history.
