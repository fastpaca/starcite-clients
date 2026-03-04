import type { AppendResult, SessionAppendInput } from "@starcite/sdk";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

export const chatUserMessageEventType = "chat.user.message";
export const chatAssistantChunkEventType = "chat.assistant.chunk";

type ChatRole = "system" | "user" | "assistant";

interface ChatUserMessagePayload {
  role: ChatRole;
  parts: unknown[];
  [key: string]: unknown;
}

interface ChatAssistantChunkPayload {
  type: string;
  [key: string]: unknown;
}

export type ChatPayloadEnvelope =
  | {
      kind: typeof chatUserMessageEventType;
      message: ChatUserMessagePayload;
      [key: string]: unknown;
    }
  | {
      kind: typeof chatAssistantChunkEventType;
      chunk: ChatAssistantChunkPayload;
      [key: string]: unknown;
    };

interface SessionAppender {
  append: (input: SessionAppendInput) => Promise<AppendResult>;
}

function isChatEventType(type: string): boolean {
  return (
    type === chatUserMessageEventType || type === chatAssistantChunkEventType
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseUserEnvelope(
  payload: Record<string, unknown>
): ChatPayloadEnvelope {
  const message = payload.message;
  if (!isRecord(message)) {
    throw new Error("Invalid chat payload envelope: missing message");
  }

  const role = message.role;
  const parts = message.parts;

  if (role !== "system" && role !== "user" && role !== "assistant") {
    throw new Error("Invalid chat payload envelope: invalid message role");
  }

  if (!Array.isArray(parts)) {
    throw new Error("Invalid chat payload envelope: invalid message parts");
  }

  return {
    ...payload,
    kind: chatUserMessageEventType,
    message: {
      ...message,
      role,
      parts,
    },
  };
}

function parseAssistantEnvelope(
  payload: Record<string, unknown>
): ChatPayloadEnvelope {
  const chunk = payload.chunk;
  if (!isRecord(chunk)) {
    throw new Error("Invalid chat payload envelope: missing chunk");
  }

  const type = chunk.type;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error("Invalid chat payload envelope: invalid chunk type");
  }

  return {
    ...payload,
    kind: chatAssistantChunkEventType,
    chunk: {
      ...chunk,
      type,
    },
  };
}

export function createUserMessageEnvelope<
  TMessage extends Record<string, unknown>,
>(
  message: TMessage
): {
  kind: typeof chatUserMessageEventType;
  message: TMessage;
} {
  return {
    kind: chatUserMessageEventType,
    message,
  };
}

export function createAssistantChunkEnvelope<
  TChunk extends Record<string, unknown>,
>(
  chunk: TChunk
): {
  kind: typeof chatAssistantChunkEventType;
  chunk: TChunk;
} {
  return {
    kind: chatAssistantChunkEventType,
    chunk,
  };
}

export function parseChatPayloadEnvelope(
  payload: unknown
): ChatPayloadEnvelope {
  if (!isRecord(payload)) {
    throw new Error("Invalid chat payload envelope: payload must be an object");
  }

  const kind = payload.kind;
  if (kind === chatUserMessageEventType) {
    return parseUserEnvelope(payload);
  }

  if (kind === chatAssistantChunkEventType) {
    return parseAssistantEnvelope(payload);
  }

  throw new Error("Invalid chat payload envelope: unknown kind");
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

  try {
    for await (const message of readUIMessageStream({
      stream,
      terminateOnError: false,
    })) {
      if (!latestById.has(message.id)) {
        messageIds.push(message.id);
      }

      latestById.set(message.id, message);
    }
  } catch {
    // Best effort: keep messages emitted before malformed chunk sequences.
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

export async function toUIMessagesFromEvents(
  events: readonly { type: string; payload: unknown }[]
): Promise<UIMessage[]> {
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
      messages.push(envelope.message as unknown as UIMessage);
      continue;
    }

    bufferedChunks.push(envelope.chunk as unknown as UIMessageChunk);
  }

  await flushBufferedChunks();
  return messages;
}
