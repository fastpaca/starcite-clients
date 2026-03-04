import type { AppendResult, SessionAppendInput } from "@starcite/sdk";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";

export const chatUserMessageEventType = "chat.user.message";
export const chatAssistantChunkEventType = "chat.assistant.chunk";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.unknown()),
});

const chatChunkSchema = z.object({
  type: z.string().min(1),
});

const userEnvelopeSchema = z.object({
  kind: z.literal(chatUserMessageEventType),
  message: chatMessageSchema.passthrough(),
});

const assistantEnvelopeSchema = z.object({
  kind: z.literal(chatAssistantChunkEventType),
  chunk: chatChunkSchema.passthrough(),
});

const chatPayloadEnvelopeSchema = z.discriminatedUnion("kind", [
  userEnvelopeSchema.passthrough(),
  assistantEnvelopeSchema.passthrough(),
]);

export type ChatPayloadEnvelope = z.infer<typeof chatPayloadEnvelopeSchema>;

interface SessionAppender {
  append: (input: SessionAppendInput) => Promise<AppendResult>;
}

export function isChatEventType(type: string): boolean {
  return (
    type === chatUserMessageEventType || type === chatAssistantChunkEventType
  );
}

export function parseChatPayloadEnvelope(
  payload: unknown
): ChatPayloadEnvelope {
  const result = chatPayloadEnvelopeSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(
      `Invalid chat payload envelope: ${result.error.issues[0]?.message ?? "unknown error"}`
    );
  }
  return result.data;
}

export function createUserMessageEnvelope<
  TMessage extends Record<string, unknown>,
>(
  message: TMessage
): { kind: typeof chatUserMessageEventType; message: TMessage } {
  return { kind: chatUserMessageEventType, message };
}

export function createAssistantChunkEnvelope<
  TChunk extends Record<string, unknown>,
>(chunk: TChunk): { kind: typeof chatAssistantChunkEventType; chunk: TChunk } {
  return { kind: chatAssistantChunkEventType, chunk };
}

export function appendUserMessageEvent(
  session: SessionAppender,
  message: Record<string, unknown>,
  options: { source?: string } = {}
): Promise<AppendResult> {
  return session.append({
    type: chatUserMessageEventType,
    source: options.source ?? "use-chat",
    payload: createUserMessageEnvelope(message),
  });
}

export function appendAssistantChunkEvent(
  session: SessionAppender,
  chunk: Record<string, unknown>,
  options: { source?: string } = {}
): Promise<AppendResult> {
  return session.append({
    type: chatAssistantChunkEventType,
    source: options.source ?? "openai",
    payload: createAssistantChunkEnvelope(chunk),
  });
}

async function buildChunkMessages<TMessage extends UIMessage = UIMessage>(
  chunks: readonly UIMessageChunk[]
): Promise<TMessage[]> {
  if (chunks.length === 0) {
    return [];
  }

  const messageIds: string[] = [];
  const latestById = new Map<string, TMessage>();
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

  try {
    for await (const message of readUIMessageStream({
      stream,
      terminateOnError: false,
    })) {
      if (!latestById.has(message.id)) {
        messageIds.push(message.id);
      }

      latestById.set(message.id, message as TMessage);
    }
  } catch {
    // Best effort: keep messages emitted before malformed chunk sequences.
  }

  const messages: TMessage[] = [];
  for (const messageId of messageIds) {
    const message = latestById.get(messageId);
    if (message) {
      messages.push(message);
    }
  }

  return messages;
}

export async function toUIMessagesFromEvents<
  TMessage extends UIMessage = UIMessage,
>(events: readonly { type: string; payload: unknown }[]): Promise<TMessage[]> {
  const messages: TMessage[] = [];
  const bufferedChunks: UIMessageChunk[] = [];

  const flushBufferedChunks = async (): Promise<void> => {
    if (bufferedChunks.length === 0) {
      return;
    }

    messages.push(...(await buildChunkMessages<TMessage>(bufferedChunks)));
    bufferedChunks.length = 0;
  };

  for (const event of events) {
    if (!isChatEventType(event.type)) {
      continue;
    }

    let envelope: ChatPayloadEnvelope;
    try {
      envelope = parseChatPayloadEnvelope(event.payload);
    } catch {
      // Skip malformed chat payloads and continue projecting the rest.
      continue;
    }

    if (envelope.kind === chatUserMessageEventType) {
      await flushBufferedChunks();
      messages.push(envelope.message as unknown as TMessage);
      continue;
    }

    bufferedChunks.push(envelope.chunk as unknown as UIMessageChunk);
  }

  await flushBufferedChunks();
  return messages;
}
