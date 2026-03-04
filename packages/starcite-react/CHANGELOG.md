# Changelog

## [Unreleased]

### Added

- `useStarciteChat` hook for single-session durable Starcite chat state.
- Drop-in return surface aligned with `useChat`: `{ messages, sendMessage, status }`.
- Durable event projection from `chat.user.message` and `chat.assistant.chunk` envelopes.
- Chat protocol helpers now live in this package and are exported at `@starcite/react/chat-protocol`.
