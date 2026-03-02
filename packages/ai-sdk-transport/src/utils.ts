import type { ModelMessage, UIMessage, UIMessageChunk } from "ai";
import { convertToModelMessages, readUIMessageStream } from "ai";
import { parseChatPayloadEnvelope } from "./transport";

type HistoryMessage = Omit<UIMessage, "id">;

async function buildChunkMessages(
  chunks: readonly UIMessageChunk[]
): Promise<HistoryMessage[]> {
  if (chunks.length === 0) {
    return [];
  }

  const messageIds: string[] = [];
  const latestById = new Map<string, HistoryMessage>();
  let index = 0;

  const stream = new ReadableStream<UIMessageChunk>({
    pull(controller) {
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }

      controller.enqueue(chunk);
      index += 1;
    },
  });

  for await (const message of readUIMessageStream({
    stream,
    terminateOnError: true,
  })) {
    if (!latestById.has(message.id)) {
      messageIds.push(message.id);
    }

    const { id: _id, ...withoutId } = message;
    latestById.set(message.id, withoutId);
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

export async function toUIMessagesFromEvents<
  TEvent extends { payload: unknown },
>(events: readonly TEvent[]): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = [];
  const bufferedChunks: UIMessageChunk[] = [];

  const flushBufferedChunks = async (): Promise<void> => {
    if (bufferedChunks.length === 0) {
      return;
    }

    messages.push(...(await buildChunkMessages(bufferedChunks)));
    bufferedChunks.length = 0;
  };

  for (const event of events) {
    const envelope = parseChatPayloadEnvelope(event.payload);

    if (envelope.kind === "chat.user.message") {
      await flushBufferedChunks();
      const { id: _id, ...message } = envelope.message;
      messages.push(message as HistoryMessage);
      continue;
    }

    bufferedChunks.push(envelope.chunk as UIMessageChunk);
  }

  await flushBufferedChunks();
  return messages;
}

export async function toModelMessagesFromEvents<
  TEvent extends { payload: unknown },
>(events: readonly TEvent[]): Promise<ModelMessage[]> {
  return convertToModelMessages(await toUIMessagesFromEvents(events));
}
