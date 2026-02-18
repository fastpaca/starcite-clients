import {
  type SessionAppendInput,
  StarciteApiError,
  type StarciteClient,
  type StarciteSession,
  type TailEvent,
} from "@starcite/sdk";
import type {
  BuildUserAppendInputArgs,
  ChatMessageLike,
  ChatTransportTrigger,
  StarciteChatTransportOptions,
  StarciteProtocolOptions,
  StarciteReconnectToStreamOptions,
  StarciteSendMessagesOptions,
  StarciteUseChatTransport,
  UIMessageChunkLike,
} from "./types";

const DEFAULT_USER_AGENT = "user";
const DEFAULT_PRODUCER_ID = "producer:use-chat";
const DEFAULT_SOURCE = "use-chat";
const DEFAULT_USER_MESSAGE_EVENT_TYPE = "chat.user.message";

const DEFAULT_PROTOCOL: StarciteProtocolOptions = {
  userMessageEventType: DEFAULT_USER_MESSAGE_EVENT_TYPE,
  responseStartEventTypes: ["chat.response.start"],
  responseDeltaEventTypes: ["chat.response.delta", "content"],
  responseEndEventTypes: ["chat.response.end", "chat.response.completed"],
  responseErrorEventTypes: ["chat.response.error"],
};

const SUBMIT_TRIGGERS = new Set<ChatTransportTrigger>([
  "submit-message",
  "submit-user-message",
]);

const REGENERATE_TRIGGERS = new Set<ChatTransportTrigger>([
  "regenerate-message",
  "regenerate-assistant-message",
]);

interface StreamState {
  messageId: string;
  textPartId: string;
  messageStarted: boolean;
  textStarted: boolean;
  streamClosed: boolean;
}

interface StreamRuntimeOptions {
  chatId: string;
  session: StarciteSession;
  cursor: number;
  abortSignal?: AbortSignal;
}

interface NormalizedTransportOptions<Message extends ChatMessageLike> {
  client: StarciteClient;
  protocol: StarciteProtocolOptions;
  userAgent: string;
  producerId: string;
  source: string;
  assistantAgents?: ReadonlySet<string>;
  closeOnFirstAssistantMessage: boolean;
  autoCreateSession: boolean;
  appendOnRegenerate: boolean;
  ensureSession?: StarciteChatTransportOptions<Message>["ensureSession"];
  buildUserAppendInput?: StarciteChatTransportOptions<Message>["buildUserAppendInput"];
}

function createRandomId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function actorToAgent(actor: string): string | undefined {
  if (!actor.startsWith("agent:")) {
    return undefined;
  }

  const agent = actor.slice("agent:".length).trim();
  return agent.length > 0 ? agent : undefined;
}

function extractMessageText(message: ChatMessageLike): string {
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) =>
        part.type === "text" && typeof part.text === "string" ? part.text : ""
      )
      .join("");
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  if (typeof message.text === "string") {
    return message.text;
  }

  return "";
}

function findLatestUserMessage<Message extends ChatMessageLike>(
  messages: Message[]
): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === "user") {
      return message;
    }
  }

  return messages.at(-1);
}

function parseCursor(metadata: unknown): number | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const directCursor = toCursor(metadata.cursor);
  if (directCursor !== undefined) {
    return directCursor;
  }

  const starciteCursor = toCursor(metadata.starciteCursor);
  if (starciteCursor !== undefined) {
    return starciteCursor;
  }

  const nested = metadata.starcite;
  if (!isRecord(nested)) {
    return undefined;
  }

  return toCursor(nested.cursor);
}

function toCursor(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0) {
      return value;
    }
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

function mergeProtocol(
  overrides: Partial<StarciteProtocolOptions> | undefined
): StarciteProtocolOptions {
  if (!overrides) {
    return {
      ...DEFAULT_PROTOCOL,
      responseStartEventTypes: [...DEFAULT_PROTOCOL.responseStartEventTypes],
      responseDeltaEventTypes: [...DEFAULT_PROTOCOL.responseDeltaEventTypes],
      responseEndEventTypes: [...DEFAULT_PROTOCOL.responseEndEventTypes],
      responseErrorEventTypes: [...DEFAULT_PROTOCOL.responseErrorEventTypes],
    };
  }

  return {
    userMessageEventType:
      overrides.userMessageEventType ?? DEFAULT_PROTOCOL.userMessageEventType,
    responseStartEventTypes: overrides.responseStartEventTypes?.length
      ? [...overrides.responseStartEventTypes]
      : [...DEFAULT_PROTOCOL.responseStartEventTypes],
    responseDeltaEventTypes: overrides.responseDeltaEventTypes?.length
      ? [...overrides.responseDeltaEventTypes]
      : [...DEFAULT_PROTOCOL.responseDeltaEventTypes],
    responseEndEventTypes: overrides.responseEndEventTypes?.length
      ? [...overrides.responseEndEventTypes]
      : [...DEFAULT_PROTOCOL.responseEndEventTypes],
    responseErrorEventTypes: overrides.responseErrorEventTypes?.length
      ? [...overrides.responseErrorEventTypes]
      : [...DEFAULT_PROTOCOL.responseErrorEventTypes],
  };
}

function isSubmitTrigger(trigger: ChatTransportTrigger): boolean {
  return SUBMIT_TRIGGERS.has(trigger);
}

function isRegenerateTrigger(trigger: ChatTransportTrigger): boolean {
  return REGENERATE_TRIGGERS.has(trigger);
}

function toSet(values: string[] | undefined): ReadonlySet<string> | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  return new Set(values);
}

function isSessionConflict(error: unknown): boolean {
  if (!(error instanceof StarciteApiError)) {
    return false;
  }

  if (error.status === 409) {
    return true;
  }

  return (
    error.code === "session_exists" ||
    error.code === "already_exists" ||
    error.message.toLowerCase().includes("already exists")
  );
}

function normalizeOptions<Message extends ChatMessageLike>(
  options: StarciteChatTransportOptions<Message>
): NormalizedTransportOptions<Message> {
  return {
    client: options.client,
    protocol: mergeProtocol(options.protocol),
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    producerId: options.producerId ?? DEFAULT_PRODUCER_ID,
    source: options.source ?? DEFAULT_SOURCE,
    assistantAgents: toSet(options.assistantAgents),
    closeOnFirstAssistantMessage: options.closeOnFirstAssistantMessage ?? true,
    autoCreateSession: options.autoCreateSession ?? true,
    appendOnRegenerate: options.appendOnRegenerate ?? false,
    ensureSession: options.ensureSession,
    buildUserAppendInput: options.buildUserAppendInput,
  };
}

/**
 * Transport adapter that allows Starcite sessions to plug into AI SDK `useChat`.
 *
 * This adapter keeps Starcite as the source of truth while mapping session tail
 * events to `useChat` UI chunks (`start`, `text-*`, `finish`).
 */
export class StarciteChatTransport<
  Message extends ChatMessageLike = ChatMessageLike,
> implements StarciteUseChatTransport<Message, UIMessageChunkLike>
{
  private readonly options: NormalizedTransportOptions<Message>;
  private readonly lastCursorByChat = new Map<string, number>();
  private readonly producerSeqByChat = new Map<string, number>();
  private readonly knownSessions = new Set<string>();

  constructor(options: StarciteChatTransportOptions<Message>) {
    this.options = normalizeOptions(options);
  }

  async sendMessages(
    options: StarciteSendMessagesOptions<Message>
  ): Promise<ReadableStream<UIMessageChunkLike>> {
    const chatId = options.chatId.trim();
    if (chatId.length === 0) {
      throw new Error("sendMessages() requires a non-empty chatId");
    }

    const session = await this.getSession(chatId);
    const trigger = options.trigger;
    const metadataCursor = parseCursor(options.metadata);
    let cursor = metadataCursor ?? this.lastCursorByChat.get(chatId) ?? 0;

    if (isSubmitTrigger(trigger)) {
      cursor = await this.appendUserMessage(session, options);
    } else if (
      isRegenerateTrigger(trigger) &&
      this.options.appendOnRegenerate
    ) {
      cursor = await this.appendUserMessage(session, options);
    }

    return this.createResponseStream({
      chatId,
      session,
      cursor,
      abortSignal: options.abortSignal,
    });
  }

  async reconnectToStream(
    options: StarciteReconnectToStreamOptions
  ): Promise<ReadableStream<UIMessageChunkLike> | null> {
    const chatId = options.chatId.trim();
    if (chatId.length === 0) {
      throw new Error("reconnectToStream() requires a non-empty chatId");
    }

    const cursor =
      parseCursor(options.metadata) ?? this.lastCursorByChat.get(chatId);

    if (cursor === undefined) {
      return null;
    }

    const session = await this.getSession(chatId);
    return this.createResponseStream({
      chatId,
      session,
      cursor,
      abortSignal: options.abortSignal,
    });
  }

  private nextProducerSeq(chatId: string): number {
    const next = (this.producerSeqByChat.get(chatId) ?? 0) + 1;
    this.producerSeqByChat.set(chatId, next);
    return next;
  }

  private async getSession(chatId: string): Promise<StarciteSession> {
    const session = this.options.client.session(chatId);

    if (this.options.autoCreateSession && !this.knownSessions.has(chatId)) {
      try {
        await this.options.client.createSession({ id: chatId });
      } catch (error) {
        if (!isSessionConflict(error)) {
          throw error;
        }
      }
    }

    if (this.options.ensureSession) {
      await this.options.ensureSession({
        chatId,
        client: this.options.client,
        session,
      });
    }

    this.knownSessions.add(chatId);
    return session;
  }

  private async appendUserMessage(
    session: StarciteSession,
    options: StarciteSendMessagesOptions<Message>
  ): Promise<number> {
    const producerSeq = this.nextProducerSeq(options.chatId);
    const input =
      this.options.buildUserAppendInput?.(
        this.createBuildUserAppendArgs(options, producerSeq)
      ) ?? this.createDefaultAppendInput(options, producerSeq);

    const response = await session.append(input);
    this.lastCursorByChat.set(options.chatId, response.seq);
    return response.seq;
  }

  private createBuildUserAppendArgs(
    options: StarciteSendMessagesOptions<Message>,
    nextProducerSeq: number
  ): BuildUserAppendInputArgs<Message> {
    return {
      chatId: options.chatId,
      trigger: options.trigger,
      messages: options.messages,
      messageId: options.messageId,
      nextProducerSeq,
      defaultUserAgent: this.options.userAgent,
      defaultProducerId: this.options.producerId,
      defaultUserMessageEventType: this.options.protocol.userMessageEventType,
    };
  }

  private createDefaultAppendInput(
    options: StarciteSendMessagesOptions<Message>,
    producerSeq: number
  ): SessionAppendInput {
    const latestUserMessage = findLatestUserMessage(options.messages);
    const text = latestUserMessage ? extractMessageText(latestUserMessage) : "";

    if (text.trim().length === 0) {
      throw new Error(
        "sendMessages() could not extract text from the latest user message"
      );
    }

    return {
      agent: this.options.userAgent,
      producerId: this.options.producerId,
      producerSeq,
      type: this.options.protocol.userMessageEventType,
      source: this.options.source,
      text,
      metadata: {
        messageId: options.messageId ?? latestUserMessage?.id,
        trigger: options.trigger,
      },
    };
  }

  private shouldConsumeEvent(event: TailEvent): boolean {
    const agent = actorToAgent(event.actor);
    if (!agent) {
      return false;
    }

    if (agent === this.options.userAgent) {
      return false;
    }

    const assistants = this.options.assistantAgents;
    return assistants ? assistants.has(agent) : true;
  }

  private createResponseStream({
    chatId,
    session,
    cursor,
    abortSignal,
  }: StreamRuntimeOptions): ReadableStream<UIMessageChunkLike> {
    const protocol = this.options.protocol;
    const startTypes = new Set(protocol.responseStartEventTypes);
    const deltaTypes = new Set(protocol.responseDeltaEventTypes);
    const endTypes = new Set(protocol.responseEndEventTypes);
    const errorTypes = new Set(protocol.responseErrorEventTypes);

    const runtimeAbort = new AbortController();

    const emitErrorAndClose = (
      controller: ReadableStreamDefaultController<UIMessageChunkLike>,
      state: StreamState,
      message: string
    ): void => {
      this.emitStart(controller, state);
      this.emitTextStart(controller, state);
      controller.enqueue({
        type: "text-delta",
        id: state.textPartId,
        delta: message,
      });
      this.finishStream(controller, state, "error");
    };

    const onExternalAbort = (): void => {
      runtimeAbort.abort();
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        runtimeAbort.abort();
      } else {
        abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    return new ReadableStream<UIMessageChunkLike>({
      start: (controller) => {
        const state: StreamState = {
          messageId: createRandomId("msg"),
          textPartId: createRandomId("text"),
          messageStarted: false,
          textStarted: false,
          streamClosed: false,
        };

        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stateful stream parsing is centralized intentionally.
        const run = async (): Promise<void> => {
          try {
            for await (const event of session.tailRaw({
              cursor,
              signal: runtimeAbort.signal,
            })) {
              this.lastCursorByChat.set(chatId, event.seq);

              if (!this.shouldConsumeEvent(event)) {
                continue;
              }

              const payload = isRecord(event.payload) ? event.payload : {};
              const payloadMessageId =
                typeof payload.messageId === "string"
                  ? payload.messageId
                  : null;
              let payloadTextPartId: string | null = null;
              if (typeof payload.textPartId === "string") {
                payloadTextPartId = payload.textPartId;
              } else if (typeof payload.id === "string") {
                payloadTextPartId = payload.id;
              }

              if (payloadMessageId && !state.messageStarted) {
                state.messageId = payloadMessageId;
              }

              if (payloadTextPartId && !state.textStarted) {
                state.textPartId = payloadTextPartId;
              }

              if (startTypes.has(event.type)) {
                this.emitStart(controller, state);
                continue;
              }

              if (deltaTypes.has(event.type)) {
                let delta = "";
                if (typeof payload.delta === "string") {
                  delta = payload.delta;
                } else if (typeof payload.text === "string") {
                  delta = payload.text;
                }

                if (delta.length === 0) {
                  continue;
                }

                this.emitStart(controller, state);
                this.emitTextStart(controller, state);

                controller.enqueue({
                  type: "text-delta",
                  id: state.textPartId,
                  delta,
                });

                if (this.options.closeOnFirstAssistantMessage) {
                  this.finishStream(controller, state, "stop");
                  return;
                }

                continue;
              }

              if (endTypes.has(event.type)) {
                const finishReason =
                  typeof payload.finishReason === "string"
                    ? payload.finishReason
                    : "stop";
                this.finishStream(controller, state, finishReason);
                return;
              }

              if (errorTypes.has(event.type)) {
                let errorMessage = "Assistant response failed.";
                if (typeof payload.error === "string") {
                  errorMessage = payload.error;
                } else if (typeof payload.message === "string") {
                  errorMessage = payload.message;
                }
                emitErrorAndClose(controller, state, errorMessage);
                return;
              }
            }

            if (state.messageStarted && !state.streamClosed) {
              this.finishStream(controller, state, "stop");
              return;
            }

            if (!state.streamClosed) {
              state.streamClosed = true;
              controller.close();
            }
          } catch (error) {
            if (runtimeAbort.signal.aborted) {
              if (!state.streamClosed) {
                state.streamClosed = true;
                controller.close();
              }
              return;
            }

            controller.error(error);
          } finally {
            if (abortSignal) {
              abortSignal.removeEventListener("abort", onExternalAbort);
            }
            runtimeAbort.abort();
          }
        };

        run().catch((error) => {
          controller.error(error);
        });
      },
      cancel: () => {
        runtimeAbort.abort();
        if (abortSignal) {
          abortSignal.removeEventListener("abort", onExternalAbort);
        }
      },
    });
  }

  private emitStart(
    controller: ReadableStreamDefaultController<UIMessageChunkLike>,
    state: StreamState
  ): void {
    if (state.messageStarted) {
      return;
    }

    controller.enqueue({
      type: "start",
      messageId: state.messageId,
    });
    state.messageStarted = true;
  }

  private emitTextStart(
    controller: ReadableStreamDefaultController<UIMessageChunkLike>,
    state: StreamState
  ): void {
    if (state.textStarted) {
      return;
    }

    controller.enqueue({
      type: "text-start",
      id: state.textPartId,
    });
    state.textStarted = true;
  }

  private finishStream(
    controller: ReadableStreamDefaultController<UIMessageChunkLike>,
    state: StreamState,
    finishReason: string
  ): void {
    if (state.streamClosed) {
      return;
    }

    this.emitStart(controller, state);
    this.emitTextStart(controller, state);

    controller.enqueue({
      type: "text-end",
      id: state.textPartId,
    });

    controller.enqueue({
      type: "finish",
      finishReason,
    });

    state.streamClosed = true;
    controller.close();
  }
}

/**
 * Factory helper for ergonomic transport creation.
 */
export function createStarciteChatTransport<
  Message extends ChatMessageLike = ChatMessageLike,
>(
  options: StarciteChatTransportOptions<Message>
): StarciteChatTransport<Message> {
  return new StarciteChatTransport(options);
}
