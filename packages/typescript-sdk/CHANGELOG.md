# Changelog

## [Unreleased]

### Added

- Session listing support: `client.listSessions(options?)` with pagination and metadata filters
- Type exports for session listing payloads/options
- First-class auth input via `apiKey` in `createStarciteClient(...)`
- Automatic bearer auth on WebSocket tail upgrades (pre-upgrade headers)
- Tail reconnect controls: `reconnect` and fixed-interval `reconnectDelayMs`
- Tail frame batching support via `tail({ batchSize })` (`1..1000`)
- Batch ingestion APIs: `tailBatches()`, `tailRawBatches()`, `tailEventBatches()`, `tailRawEventBatches()`
- Integration reconnect stress coverage with 200ms producer cadence and opt-in soak mode
- Tail backpressure guardrails via `tail({ maxBufferedBatches })` to fail fast under sustained consumer lag
- Durable stream consumption APIs: `session.consume(...)` and `session.consumeRaw(...)` with cursor-store checkpointing
- New `SessionCursorStore` / consume option types for restart-safe event processing
- Built-in cursor-store helpers: `createInMemoryCursorStore`, `createWebStorageCursorStore`, and `createLocalStorageCursorStore`
- `tail({ reconnectPolicy })` for fixed/exponential retry strategy, jitter, and max-attempt bounds
- `StarciteTailError` with structured tail failure context (`stage`, `sessionId`, `attempts`, close metadata)
- `tail({ onLifecycleEvent })` hook for structured connect/reconnect/drop/end stream events
- Reliability preset helpers: `tailOptionsForPreset(...)` and `withTailReliabilityPreset(...)`
- Reliability preset helper for durable consumption: `withConsumeReliabilityPreset(...)`

### Changed

- `append` payloads now require `producer_id`/`producer_seq` (raw) and `producerId`/`producerSeq` (high-level)
- `tail()` now auto-recovers from abnormal disconnects and resumes from the last observed sequence
- Tail streams now accept both single-event and batched WebSocket frame shapes
- Internal tail transport loop is split into a single-connection runner plus reconnect orchestrator for clearer failure-state reasoning
- `reconnectDelayMs` remains supported but now maps to `reconnectPolicy.initialDelayMs` for compatibility
