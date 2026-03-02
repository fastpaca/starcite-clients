import type { StarciteSession } from "@starcite/sdk";
import type { ChatTransport, UIMessage } from "ai";
import type {
  ChatChunk,
  ReconnectToStreamOptions,
  SendMessagesOptions,
  StarciteChatTransportOptions,
} from "./types";

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
      type: "chat.user.message",
      source: "use-chat",
      payload: payloadMessage,
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

          const chunk = event.payload as ChatChunk;
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

      if (event.type === "chat.user.message") {
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
