# [starcite](https://starcite.ai) cli

Built for multi-agent systems.

Use `starcite` to create sessions, append events, and tail shared event streams from your terminal.

For multi-agent systems:

- a) listen and monitor what each agent is producing,
- b) keep frontend/UX consumers consistent by reading from a single ordered timeline.

- Install globally: `npm install -g starcite`
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

- Your Starcite API base URL (`https://<your-instance>.starcite.io`, or local/development URL)
- Your Starcite credentials:
  - API key (recommended), or
  - an existing session token for a single session flow

For temporary usage, use `npx starcite` or `bunx starcite` instead of installing globally.

## Auth and Resolution

The CLI resolves auth in this order:

1. `--token`
2. `STARCITE_API_KEY`
3. `~/.starcite/credentials.json`
4. `apiKey` in `~/.starcite/config.json` or `~/.starcite/config.toml`

How token handling is selected:

- `create` requires a service token with tenant context that can mint a session.
- `append` and `tail`:
  - If the token is an API key with `auth:issue` scope, the CLI resolves via identity + session creation/binding.
  - Otherwise, the token is treated as a session token and must match the target `sessionId`.
- If no `--token` is supplied, stored/ambient credentials are resolved from env/config.

## Quick Start

```bash
starcite config set endpoint https://<your-instance>.starcite.io
starcite config set api-key <YOUR_API_KEY>
starcite create --id ses_demo --title "Draft contract"
starcite sessions list --limit 5
starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
starcite tail ses_demo --cursor 0 --limit 1
```

## Cloud Setup

```bash
starcite config set endpoint https://<your-instance>.starcite.io
starcite config set api-key <YOUR_KEY>
```

## Global Options

- `-u, --base-url <url>`: Starcite API base URL (highest precedence)
- `-k, --token <key>`: Starcite API key or session token (highest precedence)
- `--config-dir <path>`: Starcite CLI config directory (defaults to `~/.starcite`)
- `--json`: machine-readable JSON output
- `-v, --version`: show CLI version and exit
- `-h, --help`: show help text

Base URL resolution order:

1. `--base-url`
2. `STARCITE_BASE_URL`
3. `~/.starcite/config.json` or `~/.starcite/config.toml`

API key resolution order:

1. `--token`
2. `STARCITE_API_KEY`
3. `~/.starcite/credentials.json`
4. `apiKey` in `~/.starcite/config.json` or `~/.starcite/config.toml`

## Commands

### `version`

Print the installed CLI version.

```bash
starcite version
```

### `create`

Create a session.
Requires an API key-capable token context (typically with session minting capability).

```bash
starcite create --id ses_demo --title "Draft contract" --metadata '{"tenant_id":"acme"}'
```

### `sessions list`

List sessions from the API catalog.
Uses the resolved API credential context.

```bash
starcite sessions list
starcite sessions list --limit 20
starcite sessions list --cursor ses_123
starcite sessions list --metadata '{"tenant_id":"acme"}'
```

Useful flags:

- `--limit <count>`: max sessions to return
- `--cursor <cursor>`: pagination cursor from previous result
- `--metadata <json>`: flat JSON object of exact-match metadata filters

### `config`

Manage local configuration.

```bash
starcite config set endpoint https://<your-instance>.starcite.io
starcite config set producer-id producer:my-agent
starcite config show
```

Key aliases accepted by `config set`:

- endpoint: `endpoint`, `base-url`, `base_url`
- producer id: `producer-id`, `producer_id`
- API key: `api-key`, `api_key`

### `up`

Start local Starcite containers through an interactive wizard (Docker required).

Wizard flow:

- checks Docker / Docker Compose availability
- asks for confirmation before creating containers
- asks for API port (default from your configured base URL, fallback `45187`)
- writes compose files to `~/.starcite/runtime` (or `--config-dir`)
- runs `docker compose up -d`

Useful flags:

- `-y, --yes`: skip prompts and use defaults
- `--port <port>`: set API port
- `--db-port <port>`: set Postgres port (default `5433`)
- `--image <image>`: override Starcite Docker image

### `down`

Stop local Starcite containers.

By default this command is destructive:

- runs `docker compose down --remove-orphans -v`
- removes container volumes (`-v`) to fully reset local state

Useful flags:

- `-y, --yes`: skip confirmation prompt
- `--no-volumes`: keep Postgres volume data

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

- `config.json` or `config.toml`: optional defaults (`baseUrl`, `producerId`, `apiKey`)
- `credentials.json`: saved API key (`apiKey`)
- `identity.json`: generated stable default producer id (`cli:<hostname>:<uuid>`)
- `state.json`: persisted `nextSeqByContext` dictionary

Use `--config-dir <path>` to override the directory for testing or isolated runs.

Note: `credentials.json` contains the saved API key; `config.json`/`config.toml` may contain defaults, and environment/CLI values still take precedence.

### `tail <sessionId>`

Replay and follow events over WebSocket.

```bash
starcite tail ses_demo --cursor 0
starcite tail ses_demo --agent drafter --limit 5 --json
```

Press `Ctrl+C` to stop.

Useful flags:

- `--cursor <cursor>`: replay cursor (inclusive)
- `--agent <agent>`: filter to one `agent:<name>`
- `--limit <count>`: stop after N emitted events
- `--no-follow`: stop after replay instead of following live events

By default, `tail` starts from cursor `0` and requests batched replay frames from the API for faster catch-up.
