import type { StarciteClient, StarcitePayload } from "@starcite/sdk";
import type { UIMessageChunk } from "ai";

export interface ChatMessage {
  id?: string;
  role: string;
  parts?: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  content?: string;
  text?: string;
  [key: string]: unknown;
}

export interface SendMessagesOptions {
  chatId: string;
  messages: ChatMessage[];
  trigger?: string;
  messageId?: string;
  abortSignal?: AbortSignal;
  headers?: HeadersInit;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ReconnectToStreamOptions {
  chatId: string;
  abortSignal?: AbortSignal;
  headers?: HeadersInit;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type ChatChunk = UIMessageChunk;

export interface BuildUserPayloadOptions {
  chatId: string;
  message: ChatMessage;
  trigger?: string;
  messageId?: string;
}

export interface StarciteProtocol<
  TPayload extends StarcitePayload = StarcitePayload,
> {
  buildUserPayload(options: BuildUserPayloadOptions): TPayload | null;
  parseTailPayload(
    payload: TPayload,
    eventType: string
  ): ChatChunk | ChatChunk[] | null;
}

export interface StarciteChatTransportOptions<
  TPayload extends StarcitePayload = StarcitePayload,
> {
  client: StarciteClient<TPayload>;
  userAgent?: string;
  producerId?: string;
  protocol?: StarciteProtocol<TPayload>;
}

export interface ChatTransportLike {
  sendMessages(
    options: SendMessagesOptions
  ): Promise<ReadableStream<ChatChunk>>;
  reconnectToStream(
    options: ReconnectToStreamOptions
  ): Promise<ReadableStream<ChatChunk> | null>;
}
