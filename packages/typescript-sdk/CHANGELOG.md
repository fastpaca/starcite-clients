# Changelog

## [Unreleased]

### Added

- Session listing support: `client.listSessions(options?)` with pagination and metadata filters
- Type exports for session listing payloads/options
- First-class auth input via `apiKey` in `createStarciteClient(...)`
- Automatic bearer auth on WebSocket tail upgrades (pre-upgrade headers)
- Tail reconnect controls: `reconnect` and fixed-interval `reconnectDelayMs`
- Integration reconnect stress coverage with 200ms producer cadence and opt-in soak mode

### Changed

- `append` payloads now require `producer_id`/`producer_seq` (raw) and `producerId`/`producerSeq` (high-level)
- `tail()` now auto-recovers from abnormal disconnects and resumes from the last observed sequence
