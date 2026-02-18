import type {
  SessionAppendInput,
  StarciteClient,
  StarciteSession,
} from "@starcite/sdk";

/**
 * Transport triggers observed in AI SDK chat flows.
 */
export type ChatTransportTrigger =
  | "submit-message"
  | "regenerate-message"
  | "submit-user-message"
  | "regenerate-assistant-message"
  | (string & {});

/**
 * Minimal message-part shape used by `useChat`.
 */
export interface ChatPartLike {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Minimal message shape consumed by this transport.
 */
export interface ChatMessageLike {
  id?: string;
  role: string;
  parts?: ChatPartLike[];
  content?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Superset of fields passed to transport `sendMessages`.
 */
export interface StarciteSendMessagesOptions<
  Message extends ChatMessageLike = ChatMessageLike,
> {
  chatId: string;
  trigger: ChatTransportTrigger;
  messageId?: string;
  messages: Message[];
  abortSignal?: AbortSignal;
  headers?: HeadersInit;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Superset of fields passed to transport `reconnectToStream`.
 */
export interface StarciteReconnectToStreamOptions {
  chatId: string;
  messageId?: string;
  abortSignal?: AbortSignal;
  headers?: HeadersInit;
  body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Minimal UI chunk envelope expected by `useChat`.
 */
export interface UIMessageChunkLike {
  type: string;
  [key: string]: unknown;
}

/**
 * Contract this package exposes for `useChat` transport compatibility.
 */
export interface StarciteUseChatTransport<
  Message extends ChatMessageLike = ChatMessageLike,
  Chunk extends UIMessageChunkLike = UIMessageChunkLike,
> {
  sendMessages(
    options: StarciteSendMessagesOptions<Message>
  ): Promise<ReadableStream<Chunk>>;
  reconnectToStream(
    options: StarciteReconnectToStreamOptions
  ): Promise<ReadableStream<Chunk> | null>;
}

/**
 * Wire protocol mapping between Starcite session event types and AI SDK chunks.
 */
export interface StarciteProtocolOptions {
  userMessageEventType: string;
  responseStartEventTypes: string[];
  responseDeltaEventTypes: string[];
  responseEndEventTypes: string[];
  responseErrorEventTypes: string[];
}

/**
 * Arguments passed to custom user append mappers.
 */
export interface BuildUserAppendInputArgs<
  Message extends ChatMessageLike = ChatMessageLike,
> {
  chatId: string;
  trigger: ChatTransportTrigger;
  messages: Message[];
  messageId?: string;
  nextProducerSeq: number;
  defaultUserAgent: string;
  defaultProducerId: string;
  defaultUserMessageEventType: string;
}

/**
 * Configuration for the Starcite chat transport.
 */
export interface StarciteChatTransportOptions<
  Message extends ChatMessageLike = ChatMessageLike,
> {
  /**
   * Preconfigured Starcite client.
   */
  client: StarciteClient;
  /**
   * Session event protocol names. Defaults are suitable for a
   * `chat.user.message` + `chat.response.*` flow.
   */
  protocol?: Partial<StarciteProtocolOptions>;
  /**
   * Agent name used when appending user messages.
   */
  userAgent?: string;
  /**
   * Producer id used when appending user messages.
   */
  producerId?: string;
  /**
   * Source metadata used on user append events.
   */
  source?: string;
  /**
   * Restrict consumed assistant events to these agent names.
   */
  assistantAgents?: string[];
  /**
   * If true, a single assistant delta closes the stream with `finish`.
   * Useful for one-event-per-response backends.
   */
  closeOnFirstAssistantMessage?: boolean;
  /**
   * If true, auto-create session ids before appending.
   */
  autoCreateSession?: boolean;
  /**
   * If true, append a user event on regenerate triggers.
   */
  appendOnRegenerate?: boolean;
  /**
   * Optional hook for custom session provisioning.
   */
  ensureSession?: (args: {
    chatId: string;
    client: StarciteClient;
    session: StarciteSession;
  }) => Promise<void> | void;
  /**
   * Optional hook that maps `useChat` request data to a Starcite append input.
   */
  buildUserAppendInput?: (
    args: BuildUserAppendInputArgs<Message>
  ) => SessionAppendInput;
}
