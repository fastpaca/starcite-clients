import {
  StarciteApiError,
  type StarcitePayload,
  type StarciteSession,
} from "@starcite/sdk";
import { safeValidateUIMessages, uiMessageChunkSchema } from "ai";
import type {
  ChatChunk,
  ChatMessage,
  ChatTransportLike,
  ReconnectToStreamOptions,
  SendMessagesOptions,
  StarciteChatTransportOptions,
} from "./types";

const DEFAULT_USER_AGENT = "user";
const DEFAULT_PRODUCER_ID = "producer:use-chat";
const DEFAULT_SOURCE = "use-chat";
const USER_MESSAGE_TYPE = "chat.user.message";
const REGENERATE_TRIGGERS = new Set([
  "regenerate-message",
  "regenerate-assistant-message",
]);
const UI_CHUNK_VALIDATOR = uiMessageChunkSchema();
const validateUiChunk = (chunk: unknown) => {
  if (!UI_CHUNK_VALIDATOR.validate) {
    throw new Error("AI SDK chunk validator is unavailable");
  }

  return UI_CHUNK_VALIDATOR.validate(chunk);
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function extractText(message: ChatMessage): string {
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => {
        const record = asRecord(part);
        return part.type === "text" && typeof record.text === "string"
          ? record.text
          : "";
      })
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

function latestUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return messages[index];
    }
  }

  return messages.at(-1);
}

function shouldAppend(trigger: string | undefined): boolean {
  if (!trigger) {
    return true;
  }

  return !REGENERATE_TRIGGERS.has(trigger);
}

function randomId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function actorIsUser(actor: string, userAgent: string): boolean {
  return actor === `agent:${userAgent}`;
}

function readResponseText(payload: Record<string, unknown>): string {
  if (typeof payload.delta === "string") {
    return payload.delta;
  }

  if (typeof payload.text === "string") {
    return payload.text;
  }

  return "";
}

function readResponseError(payload: Record<string, unknown>): string {
  if (typeof payload.error === "string") {
    return payload.error;
  }

  if (typeof payload.message === "string") {
    return payload.message;
  }

  return "Assistant response failed.";
}

function readMessageId(payload: Record<string, unknown>): string {
  return typeof payload.messageId === "string"
    ? payload.messageId
    : randomId("msg");
}

function readTextId(payload: Record<string, unknown>): string {
  if (typeof payload.textPartId === "string") {
    return payload.textPartId;
  }

  if (typeof payload.id === "string") {
    return payload.id;
  }

  return randomId("text");
}

export class StarciteChatTransport<
  TPayload extends StarcitePayload = StarcitePayload,
> implements ChatTransportLike
{
  private readonly client: StarciteChatTransportOptions<TPayload>["client"];
  private readonly userAgent: string;

  private readonly knownSessions = new Set<string>();
  private readonly lastCursorByChat = new Map<string, number>();
  private readonly producerSeqByChat = new Map<string, number>();

  constructor(options: StarciteChatTransportOptions<TPayload>) {
    this.client = options.client;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async sendMessages(
    options: SendMessagesOptions
  ): Promise<ReadableStream<ChatChunk>> {
    const chatId = options.chatId.trim();
    if (chatId.length === 0) {
      throw new Error("sendMessages() requires a non-empty chatId");
    }

    const session = await this.getSession(chatId);
    const validated = await safeValidateUIMessages({
      messages: options.messages,
    });
    const messages = validated.success
      ? (validated.data as unknown as ChatMessage[])
      : options.messages;

    let cursor = this.lastCursorByChat.get(chatId) ?? 0;

    if (shouldAppend(options.trigger)) {
      cursor = await this.appendUserMessage(session, options, messages);
    }

    return this.streamResponse({
      chatId,
      session,
      cursor,
      abortSignal: options.abortSignal,
    });
  }

  async reconnectToStream(
    options: ReconnectToStreamOptions
  ): Promise<ReadableStream<ChatChunk> | null> {
    const chatId = options.chatId.trim();
    if (chatId.length === 0) {
      throw new Error("reconnectToStream() requires a non-empty chatId");
    }

    const cursor = this.lastCursorByChat.get(chatId);
    if (cursor === undefined) {
      return null;
    }

    const session = await this.getSession(chatId);
    return this.streamResponse({
      chatId,
      session,
      cursor,
      abortSignal: options.abortSignal,
    });
  }

  private async getSession(chatId: string): Promise<StarciteSession<TPayload>> {
    const session = this.client.session(chatId);

    if (!this.knownSessions.has(chatId)) {
      try {
        await this.client.createSession({ id: chatId });
      } catch (error) {
        if (!isSessionConflict(error)) {
          throw error;
        }
      }

      this.knownSessions.add(chatId);
    }

    return session;
  }

  private nextProducerSeq(chatId: string): number {
    const next = (this.producerSeqByChat.get(chatId) ?? 0) + 1;
    this.producerSeqByChat.set(chatId, next);
    return next;
  }

  private async appendUserMessage(
    session: StarciteSession<TPayload>,
    options: SendMessagesOptions,
    messages: ChatMessage[]
  ): Promise<number> {
    const userMessage = latestUserMessage(messages);
    const text = userMessage ? extractText(userMessage) : "";

    if (text.trim().length === 0) {
      throw new Error(
        "sendMessages() could not extract text from the latest user message"
      );
    }

    const response = await session.append({
      agent: this.userAgent,
      producerId: DEFAULT_PRODUCER_ID,
      producerSeq: this.nextProducerSeq(options.chatId),
      type: USER_MESSAGE_TYPE,
      source: DEFAULT_SOURCE,
      text,
      metadata: {
        messageId: options.messageId ?? userMessage?.id,
        trigger: options.trigger,
      },
    });

    this.lastCursorByChat.set(options.chatId, response.seq);
    return response.seq;
  }

  private streamResponse({
    chatId,
    session,
    cursor,
    abortSignal,
  }: {
    chatId: string;
    session: StarciteSession<TPayload>;
    cursor: number;
    abortSignal?: AbortSignal;
  }): ReadableStream<ChatChunk> {
    const runtimeAbort = new AbortController();
    const onExternalAbort = () => runtimeAbort.abort();

    if (abortSignal) {
      if (abortSignal.aborted) {
        runtimeAbort.abort();
      } else {
        abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    return new ReadableStream<ChatChunk>({
      start: (controller) => {
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear stream handling keeps this adapter easy to follow.
        const run = async () => {
          try {
            for await (const event of session.tailRaw({
              cursor,
              signal: runtimeAbort.signal,
            })) {
              this.lastCursorByChat.set(chatId, event.seq);

              if (actorIsUser(event.actor, this.userAgent)) {
                continue;
              }

              const payload = asRecord(event.payload);
              const payloadChunk = await validateUiChunk(payload);

              if (payloadChunk.success) {
                controller.enqueue(payloadChunk.value);

                if (payloadChunk.value.type === "finish") {
                  controller.close();
                  return;
                }

                continue;
              }

              if (event.type === "chat.response.error") {
                await this.emitMessage(controller, {
                  messageId: readMessageId(payload),
                  textId: readTextId(payload),
                  text: readResponseError(payload),
                  finishReason: "error",
                });
                return;
              }

              const text = readResponseText(payload);
              if (!text) {
                continue;
              }

              await this.emitMessage(controller, {
                messageId: readMessageId(payload),
                textId: readTextId(payload),
                text,
                finishReason: "stop",
              });
              return;
            }

            controller.close();
          } catch (error) {
            if (runtimeAbort.signal.aborted) {
              controller.close();
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

  private async emitMessage(
    controller: ReadableStreamDefaultController<ChatChunk>,
    args: {
      messageId: string;
      textId: string;
      text: string;
      finishReason: "stop" | "error";
    }
  ): Promise<void> {
    await this.enqueueValidatedChunk(controller, {
      type: "start",
      messageId: args.messageId,
    });
    await this.enqueueValidatedChunk(controller, {
      type: "text-start",
      id: args.textId,
    });
    await this.enqueueValidatedChunk(controller, {
      type: "text-delta",
      id: args.textId,
      delta: args.text,
    });
    await this.enqueueValidatedChunk(controller, {
      type: "text-end",
      id: args.textId,
    });
    await this.enqueueValidatedChunk(controller, {
      type: "finish",
      finishReason: args.finishReason,
    });
    controller.close();
  }

  private async enqueueValidatedChunk(
    controller: ReadableStreamDefaultController<ChatChunk>,
    chunk: unknown
  ): Promise<void> {
    const parsed = await validateUiChunk(chunk);
    if (!parsed.success) {
      throw new Error("Invalid UI message chunk generated by transport");
    }

    controller.enqueue(parsed.value);
  }
}

export function createStarciteChatTransport<
  TPayload extends StarcitePayload = StarcitePayload,
>(
  options: StarciteChatTransportOptions<TPayload>
): StarciteChatTransport<TPayload> {
  return new StarciteChatTransport(options);
}
