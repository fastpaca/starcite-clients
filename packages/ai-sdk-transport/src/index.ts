// biome-ignore lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API.
export {
  createStarciteChatTransport,
  StarciteChatTransport,
} from "./transport";

export type {
  BuildUserPayload,
  BuildUserPayloadOptions,
  ChatChunk,
  ChatMessage,
  ChatTransportLike,
  ParseTailPayload,
  ReconnectToStreamOptions,
  SendMessagesOptions,
  StarciteChatTransportOptions,
} from "./types";
