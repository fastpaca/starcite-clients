# @starcite/usechat-streaming-example

Minimal streaming app that demonstrates:

1. `useChat` from `@ai-sdk/react`
2. `StarciteChatTransport` from `@starcite/ai-sdk-transport`
3. `createStarciteClient` with optional `payloadSchema`

This example runs entirely in-browser using an in-memory Starcite backend,
so no external API server is required to validate the transport wiring.

## Run

```bash
bun install
bun run --cwd packages/usechat-streaming-example dev
```

Open http://localhost:4176.

## What This Verifies

- `useChat` sends user input through `StarciteChatTransport`.
- Transport appends to Starcite sessions and tails response events.
- AI SDK UI chunks stream back into `useChat`.
- Optional SDK payload schema enforcement is active at the Starcite SDK layer.

## Integration Shape

```ts
const client = createStarciteClient<Payload>({
  baseUrl,
  apiKey,
  payloadSchema,
});

const protocol: StarciteProtocol<Payload> = {
  buildUserPayload: ({ message }) => ({ text: message.text ?? "" }),
  parseTailPayload: (payload) =>
    "type" in payload ? (payload as unknown as ChatChunk) : null,
};

const transport = new StarciteChatTransport({
  client,
  protocol,
});

const chat = useChat({
  id: "chat_1",
  transport: transport as unknown as ChatTransport,
});
```
