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

- A running Starcite API (default: `http://localhost:45187`)
- If needed, set `STARCITE_BASE_URL` before running any command

For temporary usage, use `npx starcite` or `bunx starcite` instead of installing globally.

## Quick Start

```bash
starcite up
starcite create --id ses_demo --title "Draft contract"
starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
starcite append ses_demo --agent drafter --text "Drafted section 2 with clause references."
starcite tail ses_demo --cursor 0 --limit 1
```

## Remote Setup (No Local Docker)

```bash
starcite init
starcite config set endpoint https://cust-a.starcite.io
starcite auth login
```

Non-interactive alternative:

```bash
starcite config set endpoint https://cust-a.starcite.io
starcite config set api-key <YOUR_KEY>
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
4. `http://localhost:45187`

API key resolution order:

1. `STARCITE_API_KEY`
2. `~/.starcite/credentials.json`
3. `apiKey` in `~/.starcite/config.json` or `~/.starcite/config.toml`

## Commands

### `create`

Create a session.

```bash
starcite create --id ses_demo --title "Draft contract" --metadata '{"tenant_id":"acme"}'
```

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
starcite config set endpoint https://cust-a.starcite.io
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

Then point the CLI to the upstream compose port:

```bash
export STARCITE_BASE_URL=http://localhost:4000
```

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
