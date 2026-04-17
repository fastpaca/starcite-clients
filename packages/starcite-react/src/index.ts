/* biome-ignore-all lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API. */
export type { ChatPayloadEnvelope } from "./chat-protocol";
export {
  appendAssistantChunkEvent,
  appendAssistantTextMessage,
  appendUserMessageEvent,
  chatAssistantChunkEventType,
  chatUserMessageEventType,
  createAssistantChunkEnvelope,
  createUserMessageEnvelope,
  isChatEventType,
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
export type {
  UseStarciteSessionOptions,
  UseStarciteSessionResult,
} from "./use-starcite-session";
export { useStarciteSession } from "./use-starcite-session";
