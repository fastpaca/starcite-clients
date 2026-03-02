import type { StarciteSession } from "@starcite/sdk";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";
import type {
  ChatChunk,
  ReconnectToStreamOptions,
  SendMessagesOptions,
  StarciteChatTransportOptions,
} from "./types";

const chatUserMessageEventType = "chat.user.message";
const chatAssistantChunkEventType = "chat.assistant.chunk";

const chatUserMessagePayloadSchema = z.looseObject({
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.unknown()),
});

const chatAssistantChunkPayloadSchema = z.looseObject({
  type: z.string(),
});

const chatUserMessageEnvelopeSchema = z.looseObject({
  kind: z.literal(chatUserMessageEventType),
  message: chatUserMessagePayloadSchema,
});

const chatAssistantChunkEnvelopeSchema = z.looseObject({
  kind: z.literal(chatAssistantChunkEventType),
  chunk: chatAssistantChunkPayloadSchema,
});

const chatPayloadEnvelopeSchema = z.discriminatedUnion("kind", [
  chatUserMessageEnvelopeSchema,
  chatAssistantChunkEnvelopeSchema,
]);

const chatEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(chatUserMessageEventType),
    payload: chatUserMessageEnvelopeSchema,
  }),
  z.object({
    type: z.literal(chatAssistantChunkEventType),
    payload: chatAssistantChunkEnvelopeSchema,
  }),
]);

type ParsedChatPayloadEnvelope = z.infer<typeof chatPayloadEnvelopeSchema>;
type ParsedChatEvent = z.infer<typeof chatEventSchema>;

type SessionAppender = Pick<StarciteSession, "append">;

export function createUserMessageEnvelope<T extends Omit<UIMessage, "id">>(
  message: T
): {
  kind: typeof chatUserMessageEventType;
  message: T;
} {
  return {
    kind: chatUserMessageEventType,
    message,
  };
}

export function createAssistantChunkEnvelope<T extends UIMessageChunk>(
  chunk: T
): {
  kind: typeof chatAssistantChunkEventType;
  chunk: T;
} {
  return {
    kind: chatAssistantChunkEventType,
    chunk,
  };
}

export function parseChatPayloadEnvelope(
  payload: unknown
): ParsedChatPayloadEnvelope {
  const parsed = chatPayloadEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Invalid chat payload envelope: ${parsed.error.message}`);
  }

  return parsed.data;
}

function parseChatEvent(event: {
  type: string;
  payload: unknown;
}): ParsedChatEvent {
  const parsed = chatEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new Error(`Invalid chat event: ${parsed.error.message}`);
  }

  return parsed.data;
}

function toUserMessagePayload(
  message: UIMessage | Omit<UIMessage, "id">
): Omit<UIMessage, "id"> {
  if ("id" in message) {
    const { id: _id, ...payload } = message;
    return payload;
  }

  return message;
}

export function appendUserMessageEvent(
  session: SessionAppender,
  message: UIMessage | Omit<UIMessage, "id">,
  options: { source?: string } = {}
) {
  return session.append({
    type: chatUserMessageEventType,
    source: options.source ?? "use-chat",
    payload: createUserMessageEnvelope(toUserMessagePayload(message)),
  });
}

export function appendAssistantChunkEvent(
  session: SessionAppender,
  chunk: UIMessageChunk,
  options: { source?: string } = {}
) {
  return session.append({
    type: chatAssistantChunkEventType,
    source: options.source ?? "openai",
    payload: createAssistantChunkEnvelope(chunk),
  });
}

export class StarciteChatTransport implements ChatTransport<UIMessage> {
  private readonly session: StarciteSession;
  private lastCursor: number;

  /** The cursor used by the currently active stream to filter events. */
  private streamCursor = 0;

  /** The controller of the currently active stream (only one at a time). */
  private activeController?: ReadableStreamDefaultController<ChatChunk>;

  /** Session event subscription — kept alive across stream switches. */
  private unsubEvent?: () => void;
  private unsubError?: () => void;

  constructor(options: StarciteChatTransportOptions) {
    this.session = options.session;
    this.lastCursor = options.session.state().lastSeq;
  }

  async sendMessages(
    options: SendMessagesOptions
  ): Promise<ReadableStream<ChatChunk>> {
    const message = options.messages.at(-1);
    if (!message) {
      throw new Error("sendMessages requires at least one message.");
    }

    const appendResult = await appendUserMessageEvent(this.session, message, {
      source: "use-chat",
    });

    this.lastCursor = appendResult.seq;
    return this.streamResponse(this.lastCursor);
  }

  reconnectToStream(
    _options: ReconnectToStreamOptions
  ): Promise<ReadableStream<ChatChunk> | null> {
    return Promise.resolve(this.streamResponse(this.lastCursor || 0));
  }

  private ensureSubscribed(): void {
    if (this.unsubEvent) {
      return;
    }

    this.unsubEvent = this.session.on("event", (event) => {
      const controller = this.activeController;
      if (!controller || event.seq <= this.streamCursor) {
        return;
      }

      this.lastCursor = event.seq;

      let parsed: ParsedChatEvent;
      try {
        parsed = parseChatEvent(event);
      } catch (error) {
        controller.error(
          new Error(
            `Invalid chat event at seq=${event.seq}: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        this.teardown();
        return;
      }

      if (parsed.type === chatUserMessageEventType) {
        return;
      }

      if (parsed.type !== chatAssistantChunkEventType) {
        controller.error(
          new Error(
            `Unsupported chat event type at seq=${event.seq}: "${event.type}"`
          )
        );
        this.teardown();
        return;
      }

      const chunk = parsed.payload.chunk as ChatChunk;
      controller.enqueue(chunk);

      if (chunk.type === "finish") {
        controller.close();
        this.teardown();
      }
    });

    this.unsubError = this.session.on("error", (error) => {
      this.activeController?.error(error);
      this.teardown();
    });
  }

  private teardown(): void {
    this.activeController = undefined;
    this.unsubEvent?.();
    this.unsubEvent = undefined;
    this.unsubError?.();
    this.unsubError = undefined;
  }

  private streamResponse(cursor: number): ReadableStream<ChatChunk> {
    // Close any previously active stream to prevent duplicate event forwarding
    // (e.g. a reconnectToStream stream that is still open when sendMessages
    // is called). We do NOT unsubscribe from the session here — the single
    // subscription is reused by the new stream to avoid disrupting the
    // session's underlying websocket connection.
    try {
      this.activeController?.close();
    } catch {
      // Stream may already be closed.
    }
    this.activeController = undefined;
    this.streamCursor = cursor;

    return new ReadableStream<ChatChunk>({
      start: (controller) => {
        this.activeController = controller;
        this.ensureSubscribed();
      },
      cancel: () => {
        this.activeController = undefined;
        this.teardown();
      },
    });
  }
}

export function createStarciteChatTransport(
  options: StarciteChatTransportOptions
): ChatTransport<UIMessage> {
  return new StarciteChatTransport(options);
}
