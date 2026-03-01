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
    if (this.lastCursor === 0) {
      return Promise.resolve(null);
    }

    return Promise.resolve(this.streamResponse(this.lastCursor));
  }

  private async appendUserMessage(
    options: SendMessagesOptions
  ): Promise<number> {
    const message = options.messages.at(-1);
    if (!message) {
      throw new Error("sendMessages requires at least one message.");
    }

    const response = await this.session.append({
      type: "chat.user.message",
      source: "use-chat",
      payload: { parts: message.parts },
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
}

export function createStarciteChatTransport(
  options: StarciteChatTransportOptions
): StarciteChatTransport {
  return new StarciteChatTransport(options);
}
