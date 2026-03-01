# Changelog

## [Unreleased]

### Added

- Session catalog command: `sessions list` with pagination and metadata filters
- Local setup commands: `up` and `down` with Docker checks and interactive prompts
- `config` command with `set` and `show` subcommands for endpoint, producer id, and API key
- Core session lifecycle commands: `create`, `append`, and `tail`
- Local CLI state store under `~/.starcite` (override via `--config-dir`)
- Producer identity generation and per-context producer sequence rehydration
- Global `--token` flag for one-shot auth override (API key or session token) without persisted state
- `tail` requests batched replay frames with tuned default batch size (`256`)

### Changed

- Default local endpoint for CLI flows is now `http://localhost:45187`
