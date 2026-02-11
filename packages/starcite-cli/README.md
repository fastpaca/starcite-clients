# starcite

CLI for [Starcite](https://starcite.ai).

Use it to create sessions, append events, and tail event streams from your terminal.

## Install

```bash
npm install -g starcite
```

Or run without installing globally:

```bash
npx starcite --help
```

## Requirements

- A running Starcite API (default: `http://localhost:4000`)
- If needed, set `STARCITE_BASE_URL`

## Quick Start

```bash
starcite create --id ses_demo --title "Draft contract"
starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
starcite tail ses_demo --cursor 0
```

## Global Options

- `-u, --base-url <url>`: Starcite API base URL (defaults to `STARCITE_BASE_URL` or `http://localhost:4000`)
- `--json`: machine-readable JSON output

## Commands

### `create`

Create a session.

```bash
starcite create --id ses_demo --title "Draft contract" --metadata '{"tenant_id":"acme"}'
```

### `append <sessionId>`

Append an event.

High-level mode (`--agent` + `--text`):

```bash
starcite append ses_demo --agent drafter --text "Reviewing clause 4.2..."
```

Raw mode (`--actor` + `--payload`):

```bash
starcite append ses_demo \
  --actor agent:drafter \
  --type content \
  --payload '{"text":"Reviewing clause 4.2..."}' \
  --idempotency-key req-123 \
  --expected-seq 3
```

### `tail <sessionId>`

Replay and follow events over WebSocket.

```bash
starcite tail ses_demo --cursor 0
starcite tail ses_demo --agent drafter --limit 5
```

Press `Ctrl+C` to stop.

## Local Server with Docker

```bash
cd ~/git/fastpaca/starcite
docker compose up -d
```

Then run CLI commands against `http://localhost:4000`.

## Build Standalone Binary (Repo Dev)

From `starcite-clients`:

```bash
bun run starcite:compile
./packages/starcite-cli/dist/starcite --help
```

## Links

- Product docs and examples: https://starcite.ai
- API contract: https://github.com/fastpaca/starcite/blob/main/docs/api/rest.md
- WebSocket tail docs: https://github.com/fastpaca/starcite/blob/main/docs/api/websocket.md
