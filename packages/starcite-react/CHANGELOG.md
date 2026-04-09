# Changelog

## [Unreleased]

## [0.0.16] - 2026-04-08

### Changed

- No user-facing React API changes in this release; the package version is aligned with the `0.0.16` monorepo release and `@starcite/sdk@0.0.16`

## [0.0.15] - 2026-04-08

### Changed

- Aligned `useStarciteSession` and `useStarciteChat` with `@starcite/sdk@0.0.15`, including `TailEvent` typing and `{ phase: "replay" | "live" }` session event context
- Expanded the docs to show low-level `useStarciteSession` usage and `refreshToken` integration for durable session reconnects

### Added

- `useStarciteChat` hook for single-session durable Starcite chat state.
- Drop-in return surface aligned with `useChat`: `{ messages, sendMessage, status }`.
- Durable event projection from `chat.user.message` and `chat.assistant.chunk` envelopes.
- Chat protocol helpers now live in this package and are exported at `@starcite/react/chat-protocol`.
