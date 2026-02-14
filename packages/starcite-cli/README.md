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

- Your Starcite Cloud instance URL (`https://<your-instance>.starcite.io`)
- Your Starcite API key

For temporary usage, use `npx starcite` or `bunx starcite` instead of installing globally.

## Quick Start

```bash
starcite init --endpoint https://<your-instance>.starcite.io --api-key <YOUR_API_KEY> --yes
starcite create --id ses_demo --title "Draft contract"
starcite sessions list --limit 5
starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
starcite append ses_demo --agent drafter --text "Drafted section 2 with clause references."
starcite tail ses_demo --cursor 0 --limit 1
```

## Cloud Setup

```bash
starcite init
starcite config set endpoint https://<your-instance>.starcite.io
starcite auth login
```

Non-interactive alternative:

```bash
starcite config set endpoint https://<your-instance>.starcite.io
starcite config set api-key <YOUR_KEY>
```

## Global Options

- `-u, --base-url <url>`: Starcite API base URL (highest precedence)
- `-k, --token <token>`: Starcite API key / service JWT (highest precedence)
- `--config-dir <path>`: Starcite CLI config directory (defaults to `~/.starcite`)
- `--json`: machine-readable JSON output
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

### `create`

Create a session.

```bash
starcite create --id ses_demo --title "Draft contract" --metadata '{"tenant_id":"acme"}'
```

### `sessions list`

List sessions from the API catalog.

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

### `init`

Initialize config for remote usage.

Behavior:

- writes endpoint to `~/.starcite/config.json`
- optionally stores API key
- supports interactive prompts when flags are omitted

Useful flags:

- `--endpoint <url>`: endpoint to store
- `--api-key <key>`: API key to save
- `-y, --yes`: skip prompts and use provided values only

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

### `auth`

Manage API key auth.

```bash
starcite auth login
starcite auth status
starcite auth logout
```

`auth login` supports `--api-key <key>` for non-interactive flows.

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

### `tail <sessionId>`

Replay and follow events over WebSocket.

```bash
starcite tail ses_demo --cursor 0
starcite tail ses_demo --agent drafter --limit 5 --json
```

Press `Ctrl+C` to stop.
