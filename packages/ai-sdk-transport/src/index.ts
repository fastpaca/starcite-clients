/* biome-ignore-all lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API. */
export { toModelMessagesFromEvents, toUIMessagesFromEvents } from "./history";
export type {
  BaseChatAssistantChunkPayload,
  BaseChatUserMessagePayload,
  ChatAssistantChunkPayload,
  ChatPayloadEnvelope,
  ChatUserMessagePayload,
  ParsedChatPayloadEnvelope,
} from "./protocol";
export {
  chatAssistantChunkEnvelopeKind,
  chatAssistantChunkEnvelopeSchema,
  chatAssistantChunkEventType,
  chatPayloadEnvelopeSchema,
  chatUserMessageEnvelopeKind,
  chatUserMessageEnvelopeSchema,
  chatUserMessageEventType,
  createAssistantChunkEnvelope,
  createUserMessageEnvelope,
} from "./protocol";

export { createStarciteChatTransport } from "./transport";

export type {
  ChatChunk,
  ReconnectToStreamOptions,
  SendMessagesOptions,
  StarciteChatTransportOptions,
} from "./types";
