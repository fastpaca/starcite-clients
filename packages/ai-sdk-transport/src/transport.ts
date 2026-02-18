import { StarciteApiError, type StarciteSession } from "@starcite/sdk";
import type {
  ChatMessage,
  ChatTransportLike,
  ReconnectToStreamOptions,
  SendMessagesOptions,
  StarciteChatTransportOptions,
  UIMessageChunk,
} from "./types";

const DEFAULT_USER_AGENT = "user";
const DEFAULT_PRODUCER_ID = "producer:use-chat";
const DEFAULT_SOURCE = "use-chat";
const USER_MESSAGE_TYPE = "chat.user.message";
const REGENERATE_TRIGGERS = new Set([
  "regenerate-message",
  "regenerate-assistant-message",
]);

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

export class StarciteChatTransport implements ChatTransportLike {
  private readonly client: StarciteChatTransportOptions["client"];
  private readonly userAgent: string;

  private readonly knownSessions = new Set<string>();
  private readonly lastCursorByChat = new Map<string, number>();
  private readonly producerSeqByChat = new Map<string, number>();

  constructor(options: StarciteChatTransportOptions) {
    this.client = options.client;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async sendMessages(
    options: SendMessagesOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    const chatId = options.chatId.trim();
    if (chatId.length === 0) {
      throw new Error("sendMessages() requires a non-empty chatId");
    }

    const session = await this.getSession(chatId);
    let cursor = this.lastCursorByChat.get(chatId) ?? 0;

    if (shouldAppend(options.trigger)) {
      cursor = await this.appendUserMessage(session, options);
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
  ): Promise<ReadableStream<UIMessageChunk> | null> {
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

  private async getSession(chatId: string): Promise<StarciteSession> {
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
    session: StarciteSession,
    options: SendMessagesOptions
  ): Promise<number> {
    const userMessage = latestUserMessage(options.messages);
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
    session: StarciteSession;
    cursor: number;
    abortSignal?: AbortSignal;
  }): ReadableStream<UIMessageChunk> {
    const runtimeAbort = new AbortController();
    const onExternalAbort = () => runtimeAbort.abort();

    if (abortSignal) {
      if (abortSignal.aborted) {
        runtimeAbort.abort();
      } else {
        abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    return new ReadableStream<UIMessageChunk>({
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

              if (event.type === "chat.response.error") {
                this.emitMessage(controller, {
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

              this.emitMessage(controller, {
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

  private emitMessage(
    controller: ReadableStreamDefaultController<UIMessageChunk>,
    args: {
      messageId: string;
      textId: string;
      text: string;
      finishReason: string;
    }
  ): void {
    controller.enqueue({ type: "start", messageId: args.messageId });
    controller.enqueue({ type: "text-start", id: args.textId });
    controller.enqueue({
      type: "text-delta",
      id: args.textId,
      delta: args.text,
    });
    controller.enqueue({ type: "text-end", id: args.textId });
    controller.enqueue({ type: "finish", finishReason: args.finishReason });
    controller.close();
  }
}

export function createStarciteChatTransport(
  options: StarciteChatTransportOptions
): StarciteChatTransport {
  return new StarciteChatTransport(options);
}
