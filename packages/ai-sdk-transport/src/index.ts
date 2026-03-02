/* biome-ignore-all lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API. */
export type { ChatHistoryPayload, HistoryProjectionOptions } from "./history";
export { toModelMessagesFromEvents, toUIMessagesFromEvents } from "./history";
export { createStarciteChatTransport } from "./transport";

export type {
  ChatChunk,
  ReconnectToStreamOptions,
  SendMessagesOptions,
  StarciteChatTransportOptions,
} from "./types";
