# Changelog

## [Unreleased]

### Added

- Session catalog command: `sessions list` with pagination and metadata filters
- Local setup commands: `up` and `down` with Docker checks and interactive prompts
- Remote setup and auth commands: `init`, `config`, and `auth`
- Local CLI state store under `~/.starcite` (override via `--config-dir`)
- Producer identity generation and per-context producer sequence rehydration

### Changed

- Default local endpoint for CLI flows is now `http://localhost:45187`
