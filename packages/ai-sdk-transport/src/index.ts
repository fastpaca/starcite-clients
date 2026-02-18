// biome-ignore lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API.
export {
  createStarciteChatTransport,
  StarciteChatTransport,
} from "./transport";

export type {
  BuildUserAppendInputArgs,
  ChatMessageLike,
  ChatPartLike,
  ChatTransportTrigger,
  StarciteChatTransportOptions,
  StarciteProtocolOptions,
  StarciteReconnectToStreamOptions,
  StarciteSendMessagesOptions,
  StarciteUseChatTransport,
  UIMessageChunkLike,
} from "./types";
