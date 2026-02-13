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

- `-u, --base-url <url>`: Starcite API base URL (highest precedence)
- `--config-dir <path>`: Starcite CLI config directory (defaults to `~/.starcite`)
- `--json`: machine-readable JSON output
- `-h, --help`: show help text

Base URL resolution order:

1. `--base-url`
2. `STARCITE_BASE_URL`
3. `~/.starcite/config.json` or `~/.starcite/config.toml`
4. `http://localhost:4000`

## Commands

### `create`

Create a session.

```bash
starcite create --id ses_demo --title "Draft contract" --metadata '{"tenant_id":"acme"}'
```

### `append <sessionId>`

Append an event.
`--producer-id` and `--producer-seq` are optional.
If omitted, CLI rehydrates from `~/.starcite`:

- producer id: config (`producerId`/`producer_id`) or generated identity
- producer seq: persisted `nextSeq` per `(baseUrl, sessionId, producerId)` context
- first sequence for a new context starts at `1`

High-level mode (`--agent` + `--text`):

```bash
starcite append ses_demo --agent drafter --text "Reviewing clause 4.2..."
```

Raw mode (`--actor` + `--payload`):

```bash
starcite append ses_demo \
  --actor agent:drafter \
  --producer-id producer:drafter \
  --producer-seq 3 \
  --type content \
  --payload '{"text":"Reviewing clause 4.2..."}' \
  --idempotency-key req-123 \
  --expected-seq 3
```

## Config and State Files

By default the CLI uses `~/.starcite`:

- `config.json` or `config.toml`: optional defaults (`baseUrl`, `producerId`)
- `identity.json`: generated stable default producer id (`cli:<hostname>:<uuid>`)
- `state.json`: persisted `nextSeqByContext` dictionary

Use `--config-dir <path>` to override the directory for testing or isolated runs.

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
