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

// Use a persistent store in production
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

Do not use API keys in browser code. Your backend mints a per-session token and sends it to the UI.

```ts
import { Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  baseUrl: import.meta.env.VITE_STARCITE_BASE_URL,
});

const { token } = await fetch("/api/chat/session", {
  method: "POST",
}).then((res) => res.json());

const session = starcite.session({ token });

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
3. Frontend binds with `session({ token })` and tails/replays safely.

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

  const session = starcite.session({ token });

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

## Public API (Current)

```ts
import {
  MemoryStore,
  Starcite,
  type AppendResult,
  type SessionEvent,
  type SessionStore,
  type StarciteWebSocket,
} from "@starcite/sdk";

// ── Construction ────────────────────────────────────────────────────────────

const starcite = new Starcite({
  apiKey: process.env.STARCITE_API_KEY, // required for server-side session creation
  baseUrl: process.env.STARCITE_BASE_URL, // default: STARCITE_BASE_URL or http://localhost:4000
  authUrl: process.env.STARCITE_AUTH_URL, // overrides iss-derived auth URL for token minting
  fetch: globalThis.fetch,
  websocketFactory: (url) => new WebSocket(url),
  store: new MemoryStore(), // cursor + event persistence (default: MemoryStore)
});

// WebSocketFactory — simplified, auth is always in access_token query string.
type WebSocketFactory = (url: string) => StarciteWebSocket;

// ── Identities (server-side, require apiKey) ───────────────────────────────

const alice = starcite.user({ id: "u_123" });
const bot = starcite.agent({ id: "planner" });

// ── Sessions ────────────────────────────────────────────────────────────────

// Server-side: creates session + mints token (async)
const aliceSession = await starcite.session({ identity: alice });
const botSession = await starcite.session({
  identity: bot,
  id: aliceSession.id,
});

// Client-side: wraps existing JWT (sync, no network calls)
const session = starcite.session({ token: "<jwt>" });

// ── Session properties ──────────────────────────────────────────────────────

session.id; // string
session.token; // string
session.identity; // StarciteIdentity
session.log; // SessionLog — canonical source of truth

// ── Session log ─────────────────────────────────────────────────────────────

session.log.events; // readonly SessionEvent[] — ordered by seq, no gaps
session.log.cursor; // number — highest applied seq

// ── Append ──────────────────────────────────────────────────────────────────

await session.append({ text: "hello" });
await session.append({ payload: { ok: true }, type: "custom", source: "user" });
// -> Promise<AppendResult> = { seq: number, deduped: boolean }

// ── Subscribe ───────────────────────────────────────────────────────────────

// Late subscribers get synchronous replay of log.events, then live events.
// WS connects lazily on first subscriber, disconnects when all leave.
const unsub = session.on("event", (event) => {
  console.log(event.seq);
});

// Fatal errors only (for example token expiry). Transient drops auto-reconnect.
const unsubErr = session.on("error", (error) => {
  console.error(error.message);
});

unsub();
unsubErr();

// ── Teardown ────────────────────────────────────────────────────────────────

session.disconnect(); // stops WS immediately, removes all listeners
```

## Tail Reliability Controls

`SessionTailOptions` supports:

- `cursor`, `batchSize`, `agent`
- `follow`, `reconnect`, `reconnectPolicy`
- `connectionTimeoutMs`, `inactivityTimeoutMs`
- `maxBufferedBatches`
- `signal`
- `onLifecycleEvent`

This is designed for robust reconnect + resume semantics in long-running multi-agent workflows.

## Session Stores

`new Starcite({ store })` accepts a `SessionStore` for cursor + retained-event
persistence across session rebinds.

- Default: `MemoryStore`
- Bring your own by implementing:
  - `load(sessionId)`
  - `save(sessionId, { cursor, events })`
  - optional `clear(sessionId)`

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

- Product: <https://starcite.ai>
- Repository: <https://github.com/fastpaca/starcite-clients>
