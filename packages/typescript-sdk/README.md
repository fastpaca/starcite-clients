# @starcite/sdk

TypeScript SDK for [Starcite](https://starcite.ai), built for multi-agent systems.

If you need a single ordered session stream across multiple producers, this is the SDK you use.

## Install

```bash
npm install @starcite/sdk
```

## Runtime Requirements

- Node.js 22+ (or Bun / modern runtime with `fetch` + `WebSocket`)
- Starcite base URL (for example `https://<your-instance>.starcite.io`)
- API key JWT for backend flows
- Session token JWTs for frontend/session-scoped flows

The SDK normalizes the API URL to `/v1` automatically.

## The Core Model

- `Starcite`: tenant-scoped client
- `StarciteIdentity`: `user` or `agent` principal tied to tenant
- `StarciteSession`: session-scoped handle for append/tail/consume/live-sync

The key split:
- backend: construct `Starcite` with `apiKey`
- frontend: construct `Starcite` without `apiKey`, bind with `session({ token })`

## How You Use This SDK

This is the practical shape teams end up using in production.

### A) Agent Backend (worker/service)

Use the identity flow. This creates or binds a session and mints a session token.

```ts
import { InMemoryCursorStore, Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
});

const cursorStore = new InMemoryCursorStore();

export async function runPlanner(prompt: string, sessionId?: string) {
  const planner = starcite.agent({ id: "planner" });

  const session = await starcite.session({
    identity: planner,
    id: sessionId,
    title: "Planning session",
    metadata: { workflow: "planner" },
  });

  await session.append({ text: `Planning started: ${prompt}` });

  await session.consume({
    cursorStore,
    reconnectPolicy: { mode: "fixed", initialDelayMs: 500, maxAttempts: 20 },
    handler: async (event) => {
      if (event.type === "content") {
        // Your business logic here.
      }
    },
  });

  await session.append({ text: "Planning complete." });

  return {
    sessionId: session.id,
    sessionToken: session.token, // hand off to UI when needed
  };
}
```

### B) User Frontend (browser)

Do not use API keys in browser code. Your backend mints a session token and sends it to the UI.

```ts
import { Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  baseUrl: import.meta.env.VITE_STARCITE_BASE_URL,
});

const { token, sessionId } = await fetch("/api/chat/session", {
  method: "POST",
}).then((res) => res.json());

const session = starcite.session({ token, id: sessionId });

const stopEvents = session.on("event", (event) => {
  // Replay + live events from canonical ordered session log.
  renderEvent(event);
});

session.on("error", (error) => {
  console.error("Session live-sync error", error);
});

await session.append({
  text: "Can you summarize the last 3 updates?",
  source: "user",
});

// cleanup on unmount/navigation
stopEvents();
session.disconnect();
```

### C) Admin Panel (ops/audit)

Typical split:
1. Backend lists sessions using API key.
2. Backend mints an admin viewer token for a selected session.
3. Frontend binds with `session({ token, id })` and tails/replays safely.

Backend:

```ts
import { Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
  authUrl: process.env.STARCITE_AUTH_URL,
});

export async function listSessionsForAdmin() {
  return await starcite.listSessions({ limit: 50 });
}

export async function mintAdminViewerToken(sessionId: string) {
  const response = await fetch(
    `${process.env.STARCITE_AUTH_URL}/api/v1/session-tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.STARCITE_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: sessionId,
        principal: { type: "user", id: "admin:dashboard" },
        scopes: ["session:read"],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to mint admin token: ${response.status}`);
  }

  return (await response.json()) as { token: string; expires_in: number };
}
```

Frontend admin inspector:

```ts
import { Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  baseUrl: import.meta.env.VITE_STARCITE_BASE_URL,
});

export async function inspectSession(sessionId: string) {
  const { token } = await fetch(`/admin/api/sessions/${sessionId}/viewer-token`).then(
    (res) => res.json()
  );

  const session = starcite.session({ token, id: sessionId });

  const stop = session.on("event", (event) => {
    appendAuditRow(event);
  });

  session.on("error", (error) => {
    showBanner(`Stream error: ${error.message}`);
  });

  return () => {
    stop();
    session.disconnect();
  };
}
```

## Session APIs (Current)

`Starcite`:
- `new Starcite(options?)`
- `user({ id })`
- `agent({ id })`
- `session({ token, id?, logOptions? }) => StarciteSession` (sync)
- `session({ identity, id?, title?, metadata?, logOptions? }) => Promise<StarciteSession>`
- `listSessions(options?, requestOptions?)`

`StarciteSession`:
- `append(input, options?)`
- `appendRaw(input, options?)`
- `tail(options?)`
- `tailBatches(options?)`
- `consume(options)`
- `on("event" | "error", listener)` / `off(...)`
- `getSnapshot()`
- `setLogOptions({ maxEvents })`
- `disconnect()` / `close()`

## Tail Reliability Controls

`SessionTailOptions` supports:
- `cursor`, `batchSize`, `agent`
- `follow`, `reconnect`, `reconnectPolicy`
- `connectionTimeoutMs`, `inactivityTimeoutMs`
- `maxBufferedBatches`
- `signal`
- `onLifecycleEvent`

This is designed for robust reconnect + resume semantics in long-running multi-agent workflows.

## Cursor Stores

For durable processing/checkpointing with `consume()`:

- `InMemoryCursorStore`
- `WebStorageCursorStore`
- `LocalStorageCursorStore`
- or bring your own via `SessionCursorStore`

## Error Types You Should Handle

- `StarciteApiError` for non-2xx responses
- `StarciteConnectionError` for transport/JSON issues
- `StarciteTailError` for streaming failures
- `StarciteTokenExpiredError` when close code `4001` is observed
- `StarciteRetryLimitError` when reconnect budget is exhausted
- `StarciteBackpressureError` when consumer buffering limits are exceeded

## Local Development

```bash
bun install
bun run --cwd packages/typescript-sdk build
bun run --cwd packages/typescript-sdk check
bun run --cwd packages/typescript-sdk check:browser:all
```

## Links

- Product: https://starcite.ai
- Repository: https://github.com/fastpaca/starcite-clients
