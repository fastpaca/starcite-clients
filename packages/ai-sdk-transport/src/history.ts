import type { ModelMessage, UIMessage, UIMessageChunk } from "ai";
import { convertToModelMessages, readUIMessageStream } from "ai";
import {
  type BaseChatAssistantChunkPayload,
  chatAssistantChunkEnvelopeKind,
  chatPayloadEnvelopeSchema,
  chatUserMessageEnvelopeKind,
  type ParsedChatPayloadEnvelope,
} from "./protocol";

type HistoryMessage = Omit<UIMessage, "id">;

function toHistoryMessage(payload: object): HistoryMessage {
  const { id: _id, ...message } = payload as { id?: unknown } & Record<
    string,
    unknown
  >;
  return message as unknown as HistoryMessage;
}

function createChunkStream(
  chunks: readonly BaseChatAssistantChunkPayload[]
): ReadableStream<UIMessageChunk> {
  let index = 0;

  return new ReadableStream<UIMessageChunk>({
    pull(controller) {
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }

      controller.enqueue(chunk as UIMessageChunk);
      index += 1;
    },
  });
}

function describeInvalidEnvelope(payload: unknown, index: number): string {
  const payloadType =
    payload !== null && typeof payload === "object"
      ? `object{${Object.keys(payload).slice(0, 8).join(",")}}`
      : typeof payload;

  return `Invalid chat payload envelope at index ${index}: payload=${payloadType}. Expected envelope kind "${chatUserMessageEnvelopeKind}" or "${chatAssistantChunkEnvelopeKind}".`;
}

function parseEnvelope(
  payload: unknown,
  index: number
): ParsedChatPayloadEnvelope {
  const parsed = chatPayloadEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(describeInvalidEnvelope(payload, index));
  }

  return parsed.data;
}

async function buildChunkMessages(
  chunks: readonly BaseChatAssistantChunkPayload[]
): Promise<HistoryMessage[]> {
  if (chunks.length === 0) {
    return [];
  }

  const messageIds: string[] = [];
  const latestById = new Map<string, HistoryMessage>();

  for await (const message of readUIMessageStream({
    stream: createChunkStream(chunks),
    terminateOnError: true,
  })) {
    if (!latestById.has(message.id)) {
      messageIds.push(message.id);
    }

    latestById.set(message.id, toHistoryMessage(message));
  }

  const messages: HistoryMessage[] = [];
  for (const messageId of messageIds) {
    const message = latestById.get(messageId);
    if (message) {
      messages.push(message);
    }
  }

  return messages;
}

/**
 * Projects Starcite chat events into AI SDK UI messages.
 *
 * This helper expects event payloads that follow the strict transport envelope
 * contract (`chatPayloadEnvelopeSchema`). Invalid envelopes throw.
 */
export async function toUIMessagesFromEvents<
  TEvent extends { payload: unknown },
>(events: readonly TEvent[]): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = [];
  const bufferedChunks: BaseChatAssistantChunkPayload[] = [];

  const flushBufferedChunks = async (): Promise<void> => {
    if (bufferedChunks.length === 0) {
      return;
    }

    messages.push(...(await buildChunkMessages(bufferedChunks)));
    bufferedChunks.length = 0;
  };

  for (const [index, event] of events.entries()) {
    const envelope = parseEnvelope(event.payload, index);

    if (envelope.kind === chatUserMessageEnvelopeKind) {
      await flushBufferedChunks();
      messages.push(toHistoryMessage(envelope.message));
      continue;
    }

    bufferedChunks.push(envelope.chunk);
  }

  await flushBufferedChunks();
  return messages;
}

/**
 * Projects Starcite chat events into AI SDK model messages.
 */
export async function toModelMessagesFromEvents<
  TEvent extends { payload: unknown },
>(events: readonly TEvent[]): Promise<ModelMessage[]> {
  const messages = await toUIMessagesFromEvents(events);
  return convertToModelMessages(messages);
}
