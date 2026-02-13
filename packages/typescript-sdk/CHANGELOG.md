# Changelog

## [Unreleased]

### Added

- Initial TypeScript SDK with session create/append/tail primitives
- High-level session API (`starcite.create()`, `session.append()`, `session.tail()`)
- Typed API and connection errors

### Changed

- `append` payloads now require `producer_id`/`producer_seq` (raw) and `producerId`/`producerSeq` (high-level)
