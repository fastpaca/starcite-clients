# @starcite/usechat-streaming-example

Minimal streaming app that demonstrates:

1. `useChat` from `@ai-sdk/react`
2. `StarciteChatTransport` from `@starcite/ai-sdk-transport`
3. `createStarciteClient` against a real Starcite API

## Run (Local Docker)

```bash
bun install
bun run starcite -- up -y --port 45187
cp packages/usechat-streaming-example/.env.example packages/usechat-streaming-example/.env.local
bun run --cwd packages/usechat-streaming-example dev
```

Open http://localhost:4176.

By default the app uses the Vite dev-server origin and proxies `/v1` to
`http://localhost:45187`.

## Run (Remote Instance)

When testing against a remote deployment from the browser, route API traffic
through Vite proxy so auth headers stay server-side:

```bash
STARCITE_PROXY_TARGET=https://<your-instance>.starcite.io \
STARCITE_PROXY_API_KEY=<YOUR_API_KEY> \
VITE_STARCITE_CREATOR_TENANT_ID=<tenant-id> \
VITE_STARCITE_CREATOR_ID=<principal-id> \
VITE_STARCITE_CREATOR_TYPE=user \
bun run --cwd packages/usechat-streaming-example dev
```

Keep `VITE_STARCITE_BASE_URL` unset so the client uses `window.location.origin`
and calls `/v1` through the dev proxy.

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
  creatorPrincipal: {
    tenant_id: import.meta.env.VITE_STARCITE_CREATOR_TENANT_ID,
    id: import.meta.env.VITE_STARCITE_CREATOR_ID,
    type: "user",
  },
});

const chat = useChat({
  id: "chat_1",
  transport,
});
```
