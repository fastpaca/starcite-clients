# Next.js Chat UI Example

Minimal Next.js App Router demo based on `packages/usechat-streaming-example`.
It is intentionally happy-path and minimal to showcase transport wiring.
The UI uses AI Elements components so the chat UI stays clean with less hand-built markup.

It shows the smallest useful setup for:

- `useChat` from `@ai-sdk/react`
- AI Elements UI components (`conversation`, `message`, `prompt-input`)
- `StarciteChatTransport` from `@starcite/ai-sdk-transport`
- server-side session creation with `@starcite/sdk`
- server-side agent consumption with `streamText` from `ai`

## Run

From the repo root:

```bash
bun install
cp examples/nextjs-chat-ui/.env.example examples/nextjs-chat-ui/.env.local
export OPENAI_API_KEY="$(awk '/OPENAI_API_KEY/{print $4}' ~/.local/keys.fish)"
export STARCITE_API_TOKEN="$(awk '/STARCITE_API_TOKEN/{print $4}' ~/.local/keys.fish)"
bun run --cwd examples/nextjs-chat-ui dev
```

Open `http://localhost:3000`.

## What it covers

- Browser requests `/api/starcite/session`.
- Route handler creates or reuses a session using `STARCITE_API_KEY` or `STARCITE_API_TOKEN`.
- Route handler registers that session in `agent.ts`.
- Client reconstructs the session from token and uses `useChat({ transport })`.
- `StarciteChatTransport` appends user messages directly to Starcite and streams assistant chunks from Starcite websocket tail.
- Backend agent consumes `chat.user.message` events and appends `streamText(...).toUIMessageStream()` chunks into the same Starcite session.
- Session ID is user-editable and cached in `localStorage` so refresh keeps the same session timeline.
