# Changelog

## [Unreleased]

### Added

- `StarciteChatTransport` integration for AI SDK `useChat`
- `createStarciteChatTransport()` factory
- `sendMessages` appends messages as `chat.user.message` payloads and streams matching `UIMessageChunk`s from the session tail
- `reconnectToStream` resume support from the last tracked cursor
- Optional factory-based construction path for ergonomic dependency injection
