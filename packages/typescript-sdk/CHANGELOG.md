# Changelog

## [Unreleased]

## [0.0.15] - 2026-04-08

### Added

- Session token refresh support via `session({ token, refreshToken })`, automatic rebind on tail expiry and auth failures, and manual recovery with `session.refreshAuth()`
- Raw lifecycle subscriptions with `starcite.on("lifecycle", ...)` plus typed listeners for `session.hydrating`, `session.activated`, `session.freezing`, and `session.frozen`

### Changed

- `session.on("event", ...)` listeners now receive `{ phase: "replay" | "live" }` instead of the old `replayed` flag
- Public event typing now uses `TailEvent`, and `session({ identity })` now auto-refreshes its session token through the parent API key flow

### Fixed

- Phoenix channel joins now retry timeout failures instead of failing the stream immediately
- HTTP transport now preserves the default `fetch` binding and normalizes trailing slashes to avoid double-slash request paths

### Added

- Session listing support: `client.listSessions(options?)` with pagination and metadata filters
- Type exports for session listing payloads/options
- First-class auth input via `apiKey` in `Starcite` constructor options
- Automatic bearer auth header on HTTP API requests
- Built-in session stores: `MemoryStore`, `WebStorageSessionStore`, and `LocalStorageSessionStore`
- `StarciteTailError` with structured tail failure context (`stage`, `sessionId`, `attempts`, close metadata)
- Explicit `session.on("gap", ...)` support for server gap payloads

### Changed

- `session.append()` now auto-manages `actor`, `producer_id`, and `producer_seq` for convenience
- `session.append()` now serializes per-session append calls so `producer_seq` remains strictly ordered under concurrency
- `session.append()` is now the single append API; callers can still provide explicit `actor`, `payload`, `type`, and metadata fields through `SessionAppendInput`
- BREAKING: session streaming is now emitter-only through `session.on(...)`; `.tail()` and `.tailBatches(...)` were removed
- BREAKING: tail transport now uses the shared channel-based `/v1/socket` transport with one shared socket and per-session `tail:<session_id>` channels instead of the legacy raw `/v1/sessions/:id/tail` WebSocket transport
- BREAKING: `session.log.cursor` is now the numeric tail resume cursor, while `session.log.lastSeq` remains the numeric log sequence
- BREAKING: session stores now persist canonical session snapshots including `{ lastSeq, cursor, events, append? }`
- Event listeners now replay retained `session.log.events` synchronously by default, then continue from the live channel
- Chat protocol helpers were removed from `@starcite/sdk` and moved to `@starcite/react/chat-protocol`
- BREAKING: removed `session.consume(...)` and cursor-store APIs (`SessionCursorStore`, `InMemoryCursorStore`, `WebStorageCursorStore`, `LocalStorageCursorStore`)
- BREAKING: removed legacy WebSocket customization and obsolete tail error classes
- BREAKING: `Starcite` no longer defaults to an implicit in-memory store when `store` is omitted
- Tail gap payloads are now validated against the explicit server shape instead of being treated as passthrough objects
