# Changelog

## [Unreleased]

### Added

- Session catalog command: `sessions list` with pagination and metadata filters
- `config` command with `set` and `show` subcommands for endpoint and API key
- Core session lifecycle commands: `create`, `append`, and `tail`
- Local CLI state store under `~/.starcite` (override via `--config-dir`)
- SDK-backed append queue persistence and producer sequence rehydration in `state.json`
- Global `--token` flag for one-shot credential override without persisted state
- Global `--base-url` and `--json` flags

### Changed

- Default local endpoint for CLI flows is now `http://localhost:45187`
