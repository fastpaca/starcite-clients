// biome-ignore lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API.
export {
  createStarciteChatTransport,
  StarciteChatTransport,
} from "./transport";

export type {
  ChatChunk,
  ReconnectToStreamOptions,
  SendMessagesOptions,
  StarciteChatTransportOptions,
} from "./types";
