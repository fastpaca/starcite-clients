# Changelog

## [Unreleased]

### Added

- Session listing support: `client.listSessions(options?)` with pagination and metadata filters
- Type exports for session listing payloads/options
- First-class auth input via `apiKey` in `Starcite` constructor options
- Automatic bearer auth header on HTTP API requests
- Tail reconnect controls: `reconnect` and `reconnectPolicy`
- Tail frame batching support via `tail({ batchSize })` (`1..1000`)
- Tail backpressure guardrails via `tail({ maxBufferedBatches })` to fail fast under sustained consumer lag
- Built-in session stores: `MemoryStore`, `WebStorageSessionStore`, and `LocalStorageSessionStore`
- `StarciteTailError` with structured tail failure context (`stage`, `sessionId`, `attempts`, close metadata)
- `tail({ onLifecycleEvent })` hook for structured connect/reconnect/drop/end stream events

### Changed

- `session.append()` now auto-manages `actor`, `producer_id`, and `producer_seq` for convenience
- `session.append()` now serializes per-session append calls so `producer_seq` remains strictly ordered under concurrency
- `session.append()` is now the single append API; callers can still provide explicit `actor`, `payload`, `type`, and metadata fields through `SessionAppendInput`
- `tail()` now auto-recovers from abnormal disconnects and resumes from the last observed sequence
- Tail streams now accept both single-event and batched WebSocket frame shapes
- Internal tail transport loop is split into a single-connection runner plus reconnect orchestrator for clearer failure-state reasoning
- Chat protocol helpers were removed from `@starcite/sdk` and moved to `@starcite/react/chat-protocol`
- BREAKING: removed `session.consume(...)` and cursor-store APIs (`SessionCursorStore`, `InMemoryCursorStore`, `WebStorageCursorStore`, `LocalStorageCursorStore`)
- BREAKING: removed `session.tailBatches(...)`; `session.tail(options)` is now the single explicit streaming API and returns an async iterator
- BREAKING: `Starcite` no longer defaults to an implicit in-memory store when `store` is omitted
