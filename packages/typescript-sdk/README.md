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
- API key JWT for backend identity flows
- Session token JWTs for frontend/session-scoped flows
- For `session({ identity })`, auth issuer resolution through one of:
  - `authUrl` in the `Starcite` constructor
  - `STARCITE_AUTH_URL`
  - the API key JWT `iss` claim

The SDK normalizes the API URL to `/v1` automatically.

## The Core Model

- `Starcite`: tenant-scoped client
- `StarciteIdentity`: `user` or `agent` principal tied to tenant
- `StarciteSession`: session-scoped handle for append/tail/live-sync

The key split:

- backend: construct `Starcite` with `apiKey`, then bind with `session({ identity })`
- frontend: construct `Starcite` without `apiKey`, bind with `session({ token })`

Under the hood, lifecycle and session live-sync both use the shared `/v1/socket`
transport. Session streams attach to `tail:<sessionId>` Phoenix channels.

## How You Use This SDK

This is the practical shape teams end up using in production.

### A) Agent Backend (worker/service)

Use the identity flow. This creates or binds a session and mints a session token.

```ts
import { MemoryStore, Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
  authUrl: process.env.STARCITE_AUTH_URL, // optional if the API key JWT already has iss
  // Use a durable SessionStore in production.
  store: new MemoryStore(),
});

export async function runPlanner(prompt: string, sessionId?: string) {
  const planner = starcite.agent({ id: "planner" });

  const session = await starcite.session({
    identity: planner,
    id: sessionId,
    title: "Planning session",
    metadata: { workflow: "planner" },
  });

  await session.append({ text: `Planning started: ${prompt}` });

  const stop = session.on("event", async (event, context) => {
    if (context.phase === "replay") {
      return;
    }
    if (event.type === "content") {
      // Your business logic here.
    }
  });

  await session.append({ text: "Planning complete." });
  stop();

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

const session = starcite.session({
  token,
  refreshToken: async ({ sessionId }) => {
    const refreshed = await fetch("/api/chat/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).then((res) => res.json());

    return refreshed.token;
  },
});

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

export async function updateSessionHeaderForAdmin(sessionId: string) {
  const current = await starcite.getSession(sessionId);

  return await starcite.updateSession(sessionId, {
    title: "Reviewed conversation",
    metadata: { reviewed_by: "admin:dashboard" },
    expectedVersion: current.version,
  });
}

export async function archiveSessionForAdmin(sessionId: string) {
  return await starcite.archiveSession(sessionId);
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
  type SessionSnapshot,
  type SessionStore,
  type TailEvent,
} from "@starcite/sdk";

// ── Construction ────────────────────────────────────────────────────────────

const starcite = new Starcite({
  apiKey: process.env.STARCITE_API_KEY, // required for user()/agent() and session({ identity })
  baseUrl: process.env.STARCITE_BASE_URL, // default: STARCITE_BASE_URL or http://localhost:4000
  authUrl: process.env.STARCITE_AUTH_URL, // optional if STARCITE_AUTH_URL or the API key JWT iss already resolves the issuer
  fetch: globalThis.fetch,
  store: new MemoryStore(), // retained events + numeric tail cursor + append queue persistence
});

// ── Identities (server-side, require apiKey) ───────────────────────────────

const alice = starcite.user({ id: "u_123" });
const bot = starcite.agent({ id: "planner" });

// ── Lifecycle (backend-only, live-only) ────────────────────────────────────

const stopLifecycle = starcite.on("lifecycle", (event) => {
  console.log("lifecycle", event.kind, event);
});
const stopCreated = starcite.on("session.created", (event) => {
  console.log("new session", event.session_id);
});
const stopUpdated = starcite.on("session.updated", (event) => {
  console.log("session renamed", event.session_id, event.version);
});
const stopActivated = starcite.on("session.activated", (event) => {
  console.log("session activated", event.session_id);
});
// `lifecycle` forwards every backend lifecycle payload as-is.
// Typed named listeners currently cover:
// session.created | session.updated | session.archived | session.unarchived
// | session.hydrating | session.activated | session.freezing | session.frozen

// ── Sessions ────────────────────────────────────────────────────────────────

// Server-side: creates session + mints token (async)
const aliceSession = await starcite.session({ identity: alice });
const botSession = await starcite.session({
  identity: bot,
  id: aliceSession.id,
});

// Catalog reads + mutations (server-side/admin flows)
await starcite.listSessions({ limit: 50, archived: "all" });
await starcite.getSession(aliceSession.id);
await starcite.updateSession(aliceSession.id, {
  title: "Renamed session",
  metadata: { workflow: "planner" },
  expectedVersion: aliceSession.record?.version,
});
await starcite.archiveSession(aliceSession.id);
await starcite.unarchiveSession(aliceSession.id);

// Client-side: wraps existing JWT (sync, no network calls)
const session = starcite.session({
  token: "<jwt>",
  refreshToken: async ({ sessionId }) => {
    return await fetch("/api/chat/session", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    })
      .then((response) => response.json())
      .then((response) => response.token as string);
  },
});

// ── Session properties ──────────────────────────────────────────────────────

session.id; // string
session.token; // string
session.identity; // StarciteIdentity
session.log; // SessionLog — best-effort committed mirror of backend state

// ── Session log ─────────────────────────────────────────────────────────────

session.log.events; // readonly TailEvent[] — ordered committed events retained for replay
session.log.cursor; // TailCursor | undefined — numeric resume cursor from the backend
session.log.lastSeq; // number

// ── Append ──────────────────────────────────────────────────────────────────

await session.append({ text: "hello" });
await session.append({ payload: { ok: true }, type: "custom", source: "user" });
// -> Promise<AppendResult> = { seq: number, deduped: boolean }
// transient transport failures are retried with backoff while preserving append order
// terminal failures pause the queue by default so later appends cannot skip producer_seq

session.appendState();
// -> { status, pending, producerId, lastAcknowledgedProducerSeq, ... }

const snapshot: SessionSnapshot = session.state();
// -> { events, lastSeq, cursor, syncing, append }

session.on("append", (event) => {
  console.log(event.type);
  // queued | attempt_started | retry_scheduled | acknowledged | paused | cleared | resumed | reset
});

session.resumeAppendQueue(); // retry a paused or restored queue
session.resetAppendQueue(); // drop queued appends and rotate managed producer identity
await session.refreshAuth(); // manually retry the configured refreshToken callback after a failed automatic refresh

// ── Subscribe ───────────────────────────────────────────────────────────────

// Late subscribers get synchronous replay of retained committed state, then live updates.
const unsub = session.on("event", (event, context) => {
  console.log(event.seq);
  console.log(context.phase); // "replay" | "live"
});

// Skip retained replay and only receive future live events.
const stopLiveOnly = session.on(
  "event",
  (event) => {
    console.log(event.type);
  },
  { replay: false }
);

// Stream, append, schema, and store errors are surfaced here.
const unsubErr = session.on("error", (error) => {
  console.error(error.message);
});

// Optional: observe backend-reported recovery boundaries.
session.on("gap", (gap) => {
  console.log(gap.reason);
  // The SDK already advances the cursor and rejoins internally.
});

unsub();
stopLiveOnly();
unsubErr();

// ── Teardown ────────────────────────────────────────────────────────────────

session.disconnect(); // stops WS immediately, removes all listeners
```

## Session Event Semantics

- `session.on("event", listener)` replays retained `session.events()` synchronously by default, then continues with live events from the `tail:<sessionId>` channel.
- The second callback argument is `{ phase: "replay" | "live" }`.
- Pass `{ replay: false }` to skip retained replay and only receive future live events.
- Pass `{ agent: "planner" }` to filter for `actor === "agent:planner"`.
- Pass `{ schema }` to validate and narrow events before dispatch. Schema failures are surfaced through `session.on("error", ...)`.
- `session.on("gap", ...)` lets you observe server-reported gaps. The SDK still advances the numeric cursor and rejoins the channel internally.
- When `refreshToken` is configured, token expiry and append `401` / `403` responses trigger an in-place refresh, reconnect from the retained cursor, and preserve the current in-memory event log.
- If refresh still fails, the failure is surfaced through `session.on("error", ...)`. You can retry the same session in place with `session.refreshAuth()`.

## Session Stores

`new Starcite({ store })` accepts a `SessionStore` for cursor, retained events,
and the append outbox across session reconnects.

- No default store is configured. When omitted, startup catch-up replays from
  channel cursor `0`.
- Bring your own by implementing:
  - `load(sessionId)`
  - `save(sessionId, { lastSeq, cursor, events, append?, metadata? })`
  - optional `clear(sessionId)`
- `MemoryStore`, `WebStorageSessionStore`, and `LocalStorageSessionStore`
  support the same contract.
- Paused terminal failures are persisted, so a restarted session does not
  auto-replay a poisoned head append until you explicitly resume or reset it.

## Error Types You Should Handle

- `StarciteApiError` for non-2xx responses
- `StarciteConnectionError` for transport/JSON issues
- `StarciteTailError` for streaming failures
- `StarciteTokenExpiredError` when close code `4001` is observed

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
