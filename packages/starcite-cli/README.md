# [starcite](https://starcite.ai) CLI

CLI for creating sessions, appending events, tailing session timelines, and
listing sessions from a terminal.

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

- Starcite API base URL (`https://<your-instance>.starcite.io`, or a local URL)
- An API key JWT with tenant context for the backend-oriented CLI flows

The current published CLI resolves a credential from `--token` / env / config,
then passes that value into the SDK as the client `apiKey`. In practice,
`create`, `append`, `tail`, and `sessions list` are API-key-driven commands.

## Resolution Order

Base URL:

1. `--base-url`
2. `STARCITE_BASE_URL`
3. `STARCITE_API_URL`
4. `baseUrl` in `config.json` or `config.toml`
5. `http://localhost:45187`

Credential:

1. `--token`
2. `STARCITE_API_KEY`
3. `credentials.json`
4. `apiKey` in `config.json` or `config.toml`

## Quick Start

```bash
starcite config set endpoint https://<your-instance>.starcite.io
starcite config set api-key <YOUR_API_KEY>
starcite create --id ses_demo --title "Draft contract"
starcite sessions list --limit 5
starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
starcite tail ses_demo --limit 1
```

## Global Options

- `-u, --base-url <url>`: Starcite API base URL
- `-k, --token <token>`: credential override
- `--config-dir <path>`: config directory override
- `--json`: pretty JSON output where supported
- `-h, --help`: show help text
- `-v, --version`: show CLI version

## Commands

### `config`

Manage local CLI configuration.

```bash
starcite config set endpoint https://<your-instance>.starcite.io
starcite config set api-key <YOUR_API_KEY>
starcite config show
```

Supported `config set` keys:

- `endpoint`
- `base-url`
- `api-key`

`config show` prints:

- resolved endpoint
- whether an API key is present
- whether that API key came from a CLI flag, env, or local storage
- the active config directory

### `create`

Create a session. The command binds as the default agent identity
`agent:starcite-cli`.

```bash
starcite create
starcite create --id ses_demo
starcite create --id ses_demo --title "Draft contract"
starcite create --metadata '{"workflow":"planner"}'
```

Flags:

- `--id <sessionId>`
- `--title <title>`
- `--metadata <json object>`

### `append <sessionId>`

Create or bind the target session, then append one event through the SDK.

```bash
starcite append ses_demo --text "hello"
starcite append ses_demo --agent drafter --text "Reviewing clause 4.2..."
starcite append ses_demo --user alice --payload '{"text":"hello","channel":"chat"}'
starcite append ses_demo --type content --metadata '{"workflow":"planner"}' --text "done"
```

Behavior:

- If neither `--agent` nor `--user` is provided, the CLI binds as `agent:starcite-cli`.
- `--text` is shorthand for payload `{ "text": "..." }`.
- Default event type is `content`.
- Producer identity and producer sequence are managed by the SDK append queue.

Flags:

- `--agent <id>`
- `--user <id>`
- `--text <text>`
- `--type <type>`
- `--source <source>`
- `--payload <json object>`
- `--metadata <json object>`
- `--refs <json object>`
- `--idempotency-key <key>`
- `--expected-seq <non-negative integer>`

Constraints:

- choose one identity source: `--agent` or `--user`
- choose one payload source: `--text` or `--payload`
- one of `--text` or `--payload` is required

### `tail <sessionId>`

Bind the session, stream events, and optionally keep following live updates.

```bash
starcite tail ses_demo
starcite tail ses_demo --agent drafter --limit 5 --json
starcite tail ses_demo --cursor 10 --no-follow
```

Flags:

- `--cursor <seq>`
- `--agent <agent>`
- `--limit <count>`
- `--no-follow`

Behavior:

- `--agent` filters emitted events to `actor === "agent:<name>"`.
- `--cursor` filters output to events with `seq >= <value>`.
- Transport resume comes from the SDK session store when cached state exists; without cached state the session tail attaches from cursor `0`.
- Without `--no-follow`, the command keeps following live events until interrupted.
- With `--no-follow`, the command exits after replay and a short idle window.

### `sessions list`

List sessions from the API catalog.

```bash
starcite sessions list
starcite sessions list --limit 20
starcite sessions list --cursor next_page_token
starcite sessions list --metadata '{"workflow":"planner"}'
```

Flags:

- `--limit <positive integer>`
- `--cursor <cursor>`
- `--metadata <json object of string values>`

Notes:

- The command requires the literal subcommand `list`.
- The CLI prints a warning because `sessions list` is not recommended as a production hot path.

## Config and State Files

By default the CLI uses `~/.starcite`:

- `config.json` or `config.toml`: optional defaults such as `baseUrl` and `apiKey`
- `credentials.json`: saved API key
- `state.json`: SDK session-store state keyed by base URL and session id

The CLI forwards the resolved base URL into the SDK, so either
`https://tenant.starcite.io` or `https://tenant.starcite.io/v1` works.

`state.json` is where retained events, numeric tail cursor, and append queue
state are cached. It does not cache session tokens.

Use `--config-dir <path>` to isolate runs or tests.
