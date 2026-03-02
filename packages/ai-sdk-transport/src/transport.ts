import type { StarciteSession } from "@starcite/sdk";
import type { ChatTransport, UIMessage } from "ai";
import { z } from "zod";
import {
  chatAssistantChunkEnvelopeSchema,
  chatAssistantChunkEventType,
  chatUserMessageEnvelopeSchema,
  chatUserMessageEventType,
  createUserMessageEnvelope,
} from "./protocol";
import type {
  ChatChunk,
  ReconnectToStreamOptions,
  SendMessagesOptions,
  StarciteChatTransportOptions,
} from "./types";

const assistantChunkEventSchema = z.object({
  type: z.literal(chatAssistantChunkEventType),
  payload: chatAssistantChunkEnvelopeSchema,
});

const userMessageEventSchema = z.object({
  type: z.literal(chatUserMessageEventType),
  payload: chatUserMessageEnvelopeSchema,
});

export class StarciteChatTransport implements ChatTransport<UIMessage> {
  private readonly session: StarciteSession;

  private lastCursor = 0;

  constructor(options: StarciteChatTransportOptions) {
    this.session = options.session;
    this.lastCursor = options.session.state().lastSeq;
  }

  async sendMessages(
    options: SendMessagesOptions
  ): Promise<ReadableStream<ChatChunk>> {
    const cursor = await this.appendUserMessage(options);
    return this.streamResponse(cursor);
  }

  reconnectToStream(
    _options: ReconnectToStreamOptions
  ): Promise<ReadableStream<ChatChunk> | null> {
    const state = this.session.state();
    const inferredUserCursor = this.findLatestUserMessageCursor(state.events);
    if (inferredUserCursor === undefined && this.lastCursor === 0) {
      return Promise.resolve(null);
    }

    const resumeCursor = Math.max(this.lastCursor, inferredUserCursor ?? 0);

    this.lastCursor = resumeCursor;
    return Promise.resolve(this.streamResponse(resumeCursor));
  }

  private async appendUserMessage(
    options: SendMessagesOptions
  ): Promise<number> {
    const message = options.messages.at(-1);
    if (!message) {
      throw new Error("sendMessages requires at least one message.");
    }

    const { id: _id, ...payloadMessage } = message;

    const response = await this.session.append({
      type: chatUserMessageEventType,
      source: "use-chat",
      payload: createUserMessageEnvelope(payloadMessage),
    });

    this.lastCursor = response.seq;
    return response.seq;
  }

  private streamResponse(cursor: number): ReadableStream<ChatChunk> {
    let unsubEvent: (() => void) | undefined;
    let unsubError: (() => void) | undefined;

    const cleanup = () => {
      unsubEvent?.();
      unsubError?.();
    };

    return new ReadableStream<ChatChunk>({
      start: (controller) => {
        unsubEvent = this.session.on("event", (event) => {
          if (event.seq <= cursor) {
            return;
          }

          this.lastCursor = event.seq;

          if (event.type === chatUserMessageEventType) {
            const parsedUser = userMessageEventSchema.safeParse(event);
            if (!parsedUser.success) {
              controller.error(
                new Error(
                  `Invalid user message envelope at seq=${event.seq} for event type "${event.type}".`
                )
              );
              cleanup();
            }
            return;
          }

          if (event.type !== chatAssistantChunkEventType) {
            controller.error(
              new Error(
                `Unsupported chat event type at seq=${event.seq}: "${event.type}".`
              )
            );
            cleanup();
            return;
          }

          const parsed = assistantChunkEventSchema.safeParse(event);
          if (!parsed.success) {
            controller.error(
              new Error(
                `Invalid assistant chunk envelope at seq=${event.seq} for event type "${event.type}".`
              )
            );
            cleanup();
            return;
          }

          const chunk = parsed.data.payload.chunk as ChatChunk;
          controller.enqueue(chunk);

          if (chunk.type === "finish") {
            controller.close();
            cleanup();
          }
        });

        unsubError = this.session.on("error", (error) => {
          controller.error(error);
          cleanup();
        });
      },
      cancel: cleanup,
    });
  }

  private findLatestUserMessageCursor(
    events: ReadonlyArray<{ seq: number; type: string }>
  ): number | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) {
        continue;
      }

      if (event.type === chatUserMessageEventType) {
        return event.seq;
      }
    }
    return undefined;
  }
}

export function createStarciteChatTransport(
  options: StarciteChatTransportOptions
): ChatTransport<UIMessage> {
  return new StarciteChatTransport(options);
}
