import type { StarciteClient } from "@starcite/sdk";

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

export interface UIMessageChunk {
  type: string;
  [key: string]: unknown;
}

export interface StarciteChatTransportOptions {
  client: StarciteClient;
  userAgent?: string;
}

export interface ChatTransportLike {
  sendMessages(
    options: SendMessagesOptions
  ): Promise<ReadableStream<UIMessageChunk>>;
  reconnectToStream(
    options: ReconnectToStreamOptions
  ): Promise<ReadableStream<UIMessageChunk> | null>;
}
