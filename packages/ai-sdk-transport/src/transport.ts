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

type ParsedChatPayloadEnvelope = z.infer<typeof chatPayloadEnvelopeSchema>;

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

export function appendUserMessageEvent(
  session: SessionAppender,
  message: UIMessage,
  options: { source?: string } = {}
) {
  return session.append({
    type: chatUserMessageEventType,
    source: options.source ?? "use-chat",
    payload: createUserMessageEnvelope(message),
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

/**
 * Returns `true` when the session events contain an assistant generation that
 * has not yet received a `finish` chunk — i.e. a generation is still
 * in-progress and `reconnectToStream` should resume it.
 */
function hasIncompleteGeneration(
  events: readonly { type: string; payload: unknown }[]
): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) {
      continue;
    }
    if (event.type !== chatAssistantChunkEventType) {
      continue;
    }

    const parsed = chatAssistantChunkEnvelopeSchema.safeParse(event.payload);
    if (!parsed.success) {
      continue;
    }

    return parsed.data.chunk.type !== "finish";
  }

  return false;
}

export class StarciteChatTransport<T extends UIMessage = UIMessage>
  implements ChatTransport<T>
{
  private readonly session: StarciteSession;
  private lastCursor: number;

  /** The cursor used by the currently active stream to filter events. */
  private streamCursor = 0;

  /** The controller of the currently active stream (only one at a time). */
  private activeController?: ReadableStreamDefaultController<ChatChunk>;

  /** Session event subscription — kept alive across stream switches. */
  private unsubEvent?: () => void;
  private unsubError?: () => void;

  /**
   * Tracks whether an assistant generation is currently in progress.
   * Initialized from persisted session events (e.g. localStorage) and kept
   * up-to-date as live events flow through the subscription.
   */
  private generationInProgress: boolean;

  constructor(options: StarciteChatTransportOptions) {
    this.session = options.session;
    this.lastCursor = options.session.state().lastSeq;
    this.generationInProgress = hasIncompleteGeneration(
      options.session.state().events
    );
  }

  async sendMessages(
    options: SendMessagesOptions<T>
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
    if (!this.generationInProgress) {
      return Promise.resolve(null);
    }

    return Promise.resolve(this.streamResponse(this.lastCursor));
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

      let envelope: ParsedChatPayloadEnvelope;
      try {
        envelope = parseChatPayloadEnvelope(event.payload);
      } catch (error) {
        controller.error(
          new Error(
            `Invalid chat event at seq=${event.seq}: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        this.teardown();
        return;
      }

      if (envelope.kind !== chatAssistantChunkEventType) {
        return;
      }

      const chunk = envelope.chunk as ChatChunk;
      this.generationInProgress = chunk.type !== "finish";
      controller.enqueue(chunk);

      if (chunk.type === "finish") {
        controller.close();
        this.activeController = undefined;
      }
    });

    this.unsubError = this.session.on("error", (error) => {
      this.activeController?.error(error);
      this.teardown();
    });
  }

  /** Unsubscribe from the session and close any active stream. */
  dispose(): void {
    this.teardown();
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

export function createStarciteChatTransport<T extends UIMessage = UIMessage>(
  options: StarciteChatTransportOptions
): ChatTransport<T> {
  return new StarciteChatTransport<T>(options);
}
