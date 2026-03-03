import type { ModelMessage, UIMessage, UIMessageChunk } from "ai";
import { convertToModelMessages, readUIMessageStream } from "ai";
import { parseChatPayloadEnvelope } from "./transport";

async function buildChunkMessages(
  chunks: readonly UIMessageChunk[]
): Promise<UIMessage[]> {
  if (chunks.length === 0) {
    return [];
  }

  const messageIds: string[] = [];
  const latestById = new Map<string, UIMessage>();
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

    latestById.set(message.id, message);
  }

  const messages: UIMessage[] = [];
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
>(events: readonly TEvent[]): Promise<UIMessage[]> {
  const messages: UIMessage[] = [];
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
      // The zod `looseObject` schema preserves all original fields (including
      // `id`) at runtime, but the inferred static type only declares `role` and
      // `parts`. Cast through `unknown` so we keep the full passthrough shape.
      messages.push(envelope.message as unknown as UIMessage);
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
