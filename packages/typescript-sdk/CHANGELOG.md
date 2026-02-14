# Changelog

## [Unreleased]

### Added

- Session listing support: `client.listSessions(options?)` with pagination and metadata filters
- Type exports for session listing payloads/options

### Changed

- `append` payloads now require `producer_id`/`producer_seq` (raw) and `producerId`/`producerSeq` (high-level)
