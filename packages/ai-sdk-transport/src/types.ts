import type { StarciteClient, StarcitePayload } from "@starcite/sdk";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

export type ChatMessage = UIMessage;
export type SendMessagesOptions = Parameters<
  ChatTransport<UIMessage>["sendMessages"]
>[0];
export type ReconnectToStreamOptions = Parameters<
  ChatTransport<UIMessage>["reconnectToStream"]
>[0];

export type ChatChunk = UIMessageChunk;

export interface StarciteChatTransportOptions<
  TPayload extends StarcitePayload = StarcitePayload,
> {
  client: StarciteClient<TPayload>;
  userAgent?: string;
  producerId?: string;
}
