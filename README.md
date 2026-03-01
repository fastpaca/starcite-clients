# [Starcite](https://starcite.ai) Clients

Clients for building and operating multi-agent systems on one ordered session timeline.

## Packages

- `@starcite/sdk` (`packages/typescript-sdk`) for app and browser integration
- `starcite` (`packages/starcite-cli`) for terminal workflows

Detailed package docs:
- SDK guide: `packages/typescript-sdk/README.md`
- CLI guide: `packages/starcite-cli/README.md`

## Public SDK Surface

```ts
import { MemoryStore, Starcite, type StarciteWebSocket } from "@starcite/sdk";

const starcite = new Starcite({
  apiKey: process.env.STARCITE_API_KEY, // required for server-side session creation
  baseUrl: process.env.STARCITE_BASE_URL, // default: STARCITE_BASE_URL or http://localhost:4000
  authUrl: process.env.STARCITE_AUTH_URL, // overrides iss-derived auth URL for token minting
  fetch: globalThis.fetch,
  websocketFactory: (url) => new WebSocket(url),
  store: new MemoryStore(), // cursor + event persistence (default: MemoryStore)
});

type WebSocketFactory = (url: string) => StarciteWebSocket;

const alice = starcite.user({ id: "u_123" });
const bot = starcite.agent({ id: "planner" });

const aliceSession = await starcite.session({ identity: alice });
const botSession = await starcite.session({
  identity: bot,
  id: aliceSession.id,
});

const session = starcite.session({ token: "<jwt>" }); // sync, no network call

session.id; // string
session.token; // string
session.identity; // StarciteIdentity
session.log.events; // readonly SessionEvent[], ordered by seq with no gaps
session.log.cursor; // number, highest applied seq

await session.append({ text: "hello" }); // Promise<AppendResult> { seq, deduped }

const unsub = session.on("event", (event) => {
  console.log(event.seq);
});
const unsubErr = session.on("error", (error) => {
  console.error(error.message);
});

unsub();
unsubErr();
session.disconnect();
```

## How Teams Use It

### A) Agent Backend

```ts
import { Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
});

const planner = starcite.agent({ id: "planner" });
const session = await starcite.session({ identity: planner });

await session.append({ text: "planning started" });
```

### B) User Frontend

```ts
import { Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  baseUrl: import.meta.env.VITE_STARCITE_BASE_URL,
});

const { token } = await fetch("/api/session-token").then((res) => res.json());
const session = starcite.session({ token });

const stop = session.on("event", (event) => {
  renderEvent(event);
});
```

### C) Admin Panel

```ts
import { Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  baseUrl: import.meta.env.VITE_STARCITE_BASE_URL,
});

const { token } = await fetch(`/admin/api/sessions/${sessionId}/viewer-token`).then(
  (res) => res.json()
);
const session = starcite.session({ token });

session.on("event", (event) => appendAuditRow(event));
session.on("error", (error) => showBanner(error.message));
```

## CLI Quick Start

```bash
npm install -g starcite
starcite config set endpoint https://<your-instance>.starcite.io
starcite config set api-key <YOUR_API_KEY>
starcite create --id ses_demo --title "Draft contract"
starcite sessions list --limit 5
starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
starcite tail ses_demo --cursor 0 --limit 1
```

## Development Commands

```bash
bun run build
bun run lint
bun run typecheck
bun run test
```

Build a standalone CLI binary:

```bash
bun run starcite:compile
./packages/starcite-cli/dist/starcite --help
```

## Release Process

This repo uses manual releases.

1. Create release commit and tag:

```bash
bun run release:patch
bun run release:minor
bun run release:major
```

2. Push commit and tag:

```bash
git push origin main
git push origin vX.Y.Z
```

3. Publish via GitHub release:

- Create GitHub release `vX.Y.Z`
- `publish-npm.yml` publishes `@starcite/sdk` and `starcite` on `release.published`

Required secret:

- `NPM_TOKEN` (`Settings -> Secrets and variables -> Actions`)
