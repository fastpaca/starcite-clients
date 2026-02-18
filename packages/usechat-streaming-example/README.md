# @starcite/usechat-streaming-example

Minimal streaming app that demonstrates:

1. `useChat` from `@ai-sdk/react`
2. `StarciteChatTransport` from `@starcite/ai-sdk-transport`
3. `createStarciteClient` against a real local Starcite API

## Run

```bash
bun install
bun run starcite -- up -y --port 45187
cp packages/usechat-streaming-example/.env.example packages/usechat-streaming-example/.env.local
bun run --cwd packages/usechat-streaming-example dev
```

Open http://localhost:4176.

By default the app uses the Vite dev-server origin and proxies `/v1` to
`http://localhost:45187`. Set `VITE_STARCITE_BASE_URL` only if you want to
target a different Starcite endpoint.

## What This Verifies

- `useChat` sends user input through `StarciteChatTransport`.
- Transport appends to Starcite sessions and tails response events.
- AI SDK UI chunks from Starcite tail events stream back into `useChat`.

`StarciteChatTransport` assumes assistant events are emitted as AI SDK
`UIMessageChunk` payloads. This example does not run an assistant service.
Use any local producer that appends assistant chunks to the same session.

## Integration Shape

```ts
const client = createStarciteClient<Payload>({
  baseUrl: import.meta.env.VITE_STARCITE_BASE_URL,
  apiKey: import.meta.env.VITE_STARCITE_API_KEY,
});

const transport = new StarciteChatTransport<Payload>({
  client,
});

const chat = useChat({
  id: "chat_1",
  transport,
});
```
