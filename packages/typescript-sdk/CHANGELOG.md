# Changelog

## [Unreleased]

### Added

- Session listing support: `client.listSessions(options?)` with pagination and metadata filters
- Type exports for session listing payloads/options
- First-class auth input via `apiKey` in `Starcite` constructor options
- Automatic bearer auth header on HTTP API requests
- Tail reconnect controls: `reconnect` and `reconnectPolicy`
- Tail frame batching support via `tail({ batchSize })` (`1..1000`)
- Batch ingestion API: `tailBatches(onBatch, options?)`
- Tail backpressure guardrails via `tail({ maxBufferedBatches })` to fail fast under sustained consumer lag
- Durable stream consumption API: `session.consume(...)` with cursor-store checkpointing
- New `SessionCursorStore` / consume option types for restart-safe event processing
- Built-in cursor stores: `InMemoryCursorStore`, `WebStorageCursorStore`, and `LocalStorageCursorStore`
- `StarciteTailError` with structured tail failure context (`stage`, `sessionId`, `attempts`, close metadata)
- `tail({ onLifecycleEvent })` hook for structured connect/reconnect/drop/end stream events

### Changed

- `session.append()` now auto-manages `actor`, `producer_id`, and `producer_seq` for convenience
- Raw append support is available through `appendRaw(...)` with explicit `producer_id` and `producer_seq` requirements
- `tail()` now auto-recovers from abnormal disconnects and resumes from the last observed sequence
- Tail streams now accept both single-event and batched WebSocket frame shapes
- Internal tail transport loop is split into a single-connection runner plus reconnect orchestrator for clearer failure-state reasoning
