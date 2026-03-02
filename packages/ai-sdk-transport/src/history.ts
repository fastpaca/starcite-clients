import type { ModelMessage, UIMessage, UIMessageChunk } from "ai";
import {
  convertToModelMessages,
  readUIMessageStream,
  uiMessageChunkSchema,
} from "ai";

type HistoryMessage = Omit<UIMessage, "id">;
export type ChatHistoryPayload = HistoryMessage | UIMessageChunk;

export interface HistoryProjectionOptions {
  unknownPayloadStrategy?: "throw" | "ignore";
}

const uiMessageChunkValidator = uiMessageChunkSchema();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toMessage(payload: unknown): HistoryMessage | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  if (typeof payload.role !== "string") {
    return undefined;
  }

  if (!Array.isArray(payload.parts)) {
    return undefined;
  }

  const { id: _id, ...message } = payload as UIMessage &
    Record<string, unknown>;
  return message as HistoryMessage;
}

async function toChunk(payload: unknown): Promise<UIMessageChunk | undefined> {
  const validate = uiMessageChunkValidator.validate;
  if (!validate) {
    return undefined;
  }

  const parsed = await validate(payload);
  return parsed.success ? parsed.value : undefined;
}

function createChunkStream(
  chunks: readonly UIMessageChunk[]
): ReadableStream<UIMessageChunk> {
  let index = 0;
  return new ReadableStream<UIMessageChunk>({
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
}

function toHistoryMessage(message: UIMessage): HistoryMessage {
  const { id: _id, ...historyMessage } = message;
  return historyMessage;
}

function describePayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return `${typeof payload}`;
  }

  const keys = Object.keys(payload);
  if (keys.length === 0) {
    return "object{}";
  }

  return `object{${keys.slice(0, 8).join(",")}${keys.length > 8 ? ",..." : ""}}`;
}

async function buildChunkMessages(
  chunks: readonly UIMessageChunk[]
): Promise<HistoryMessage[]> {
  const messageIds: string[] = [];
  const latestById = new Map<string, HistoryMessage>();

  if (chunks.length === 0) {
    return [];
  }

  for await (const message of readUIMessageStream({
    stream: createChunkStream(chunks),
    terminateOnError: false,
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
 * Projects mixed Starcite payload history into AI SDK UI messages.
 */
export async function toUIMessagesFromPayloads(
  payloads: readonly unknown[],
  options: HistoryProjectionOptions = {}
): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = [];
  const bufferedChunks: UIMessageChunk[] = [];
  const unknownPayloadStrategy = options.unknownPayloadStrategy ?? "throw";

  const flushBufferedChunks = async (): Promise<void> => {
    if (bufferedChunks.length === 0) {
      return;
    }

    messages.push(...(await buildChunkMessages(bufferedChunks)));
    bufferedChunks.length = 0;
  };

  for (const [index, payload] of payloads.entries()) {
    const message = toMessage(payload);
    if (message) {
      await flushBufferedChunks();
      messages.push(message);
      continue;
    }

    const chunk = await toChunk(payload);
    if (!chunk) {
      if (unknownPayloadStrategy === "throw") {
        throw new Error(
          `Unsupported chat history payload at index ${index}: ${describePayload(payload)}. ` +
            "Expected a native AI SDK UI message payload (role + parts) or UI message chunk."
        );
      }
      continue;
    }

    bufferedChunks.push(chunk);
  }

  await flushBufferedChunks();
  return messages;
}

/**
 * Projects Starcite events into AI SDK UI messages.
 */
export function toUIMessagesFromEvents<TPayload = unknown>(
  events: readonly { payload: TPayload }[],
  options: HistoryProjectionOptions = {}
): Promise<HistoryMessage[]> {
  return toUIMessagesFromPayloads(
    events.map((event) => event.payload),
    options
  );
}

/**
 * Projects mixed Starcite payload history into AI SDK model messages.
 */
export async function toModelMessagesFromPayloads(
  payloads: readonly unknown[],
  options: HistoryProjectionOptions = {}
): Promise<ModelMessage[]> {
  const messages = await toUIMessagesFromPayloads(payloads, options);
  return convertToModelMessages(messages);
}

/**
 * Projects Starcite events into AI SDK model messages.
 */
export async function toModelMessagesFromEvents<TPayload = unknown>(
  events: readonly { payload: TPayload }[],
  options: HistoryProjectionOptions = {}
): Promise<ModelMessage[]> {
  const messages = await toUIMessagesFromEvents(events, options);
  return convertToModelMessages(messages);
}
