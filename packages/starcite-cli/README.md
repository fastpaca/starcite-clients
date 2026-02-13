# starcite

CLI for [Starcite](https://starcite.ai).

Built for multi-agent systems.

Use `starcite` to create sessions, append events, and tail shared event streams from your terminal.

For multi-agent systems:

- a) listen and monitor what each agent is producing,
- b) keep frontend/UX consumers consistent by reading from a single ordered timeline.

- Install once for local workflow: `npm install -g starcite`
- Run once with npm: `npx starcite`
- Run once with Bun: `bunx starcite`

## Install

```bash
npm install -g starcite
```

Or run without installing globally:

```bash
npx starcite --help
```

Or with Bun:

```bash
bunx starcite --help
```

## Requirements

- A running Starcite API (default: `http://localhost:4000`)
- If needed, set `STARCITE_BASE_URL` before running any command

For temporary usage, use `npx starcite` or `bunx starcite` instead of installing globally.

## Quick Start

```bash
starcite create --id ses_demo --title "Draft contract"
starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
starcite append ses_demo --agent drafter --text "Drafted section 2 with clause references."
starcite tail ses_demo --cursor 0 --limit 1
```

## Global Options

- `-u, --base-url <url>`: Starcite API base URL (defaults to `STARCITE_BASE_URL` or `http://localhost:4000`)
- `--json`: machine-readable JSON output
- `-h, --help`: show help text

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
starcite tail ses_demo --agent drafter --limit 5 --json
```

Press `Ctrl+C` to stop.

### Useful patterns

Export the event feed to a local file:

```bash
starcite tail ses_demo --cursor 0 --json --limit 1 > tail.json
```

## Local Server with Docker

If you want to follow examples end-to-end locally:

```bash
git clone https://github.com/fastpaca/starcite.git
cd starcite
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
