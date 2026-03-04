/* biome-ignore-all lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API. */
export type {
  ChatChunkLike,
  ChatMessageLike,
  ChatPayloadEnvelope,
} from "./chat-protocol";
export {
  appendAssistantChunkEvent,
  appendUserMessageEvent,
  chatAssistantChunkEventType,
  chatUserMessageEventType,
  createAssistantChunkEnvelope,
  createUserMessageEnvelope,
  isChatEventType,
  isRecord,
  parseChatPayloadEnvelope,
  toUIMessagesFromEvents,
} from "./chat-protocol";
export type {
  SendMessageInput,
  StarciteChatSession,
  UseStarciteChatOptions,
  UseStarciteChatResult,
} from "./use-starcite-chat";
export { useStarciteChat } from "./use-starcite-chat";
