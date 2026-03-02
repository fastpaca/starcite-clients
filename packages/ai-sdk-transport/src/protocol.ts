import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";

export const chatUserMessageEventType = "chat.user.message";
export const chatAssistantChunkEventType = "chat.assistant.chunk";

export const chatUserMessageEnvelopeKind = chatUserMessageEventType;
export const chatAssistantChunkEnvelopeKind = chatAssistantChunkEventType;

type CoreUserMessage = Omit<UIMessage, "id"> & { id?: never };
type CoreAssistantChunk = UIMessageChunk;

const baseChatUserMessagePayloadSchema = z
  .object({
    role: z.string(),
    parts: z.array(z.unknown()),
  })
  .passthrough();

const baseChatAssistantChunkPayloadSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

export type BaseChatUserMessagePayload = z.infer<
  typeof baseChatUserMessagePayloadSchema
>;

export type BaseChatAssistantChunkPayload = z.infer<
  typeof baseChatAssistantChunkPayloadSchema
>;

export type ChatUserMessagePayload<
  T extends CoreUserMessage = CoreUserMessage,
> = T;

export type ChatAssistantChunkPayload<
  T extends CoreAssistantChunk = CoreAssistantChunk,
> = T;

export const chatUserMessageEnvelopeSchema = z
  .object({
    kind: z.literal(chatUserMessageEnvelopeKind),
    message: baseChatUserMessagePayloadSchema,
  })
  .passthrough();

export const chatAssistantChunkEnvelopeSchema = z
  .object({
    kind: z.literal(chatAssistantChunkEnvelopeKind),
    chunk: baseChatAssistantChunkPayloadSchema,
  })
  .passthrough();

export const chatPayloadEnvelopeSchema = z.discriminatedUnion("kind", [
  chatUserMessageEnvelopeSchema,
  chatAssistantChunkEnvelopeSchema,
]);

export type ParsedChatPayloadEnvelope = z.infer<
  typeof chatPayloadEnvelopeSchema
>;

export type ChatPayloadEnvelope<
  TMessage extends CoreUserMessage = CoreUserMessage,
  TChunk extends CoreAssistantChunk = CoreAssistantChunk,
> =
  | ({
      kind: typeof chatUserMessageEnvelopeKind;
      message: ChatUserMessagePayload<TMessage>;
    } & Record<string, unknown>)
  | ({
      kind: typeof chatAssistantChunkEnvelopeKind;
      chunk: ChatAssistantChunkPayload<TChunk>;
    } & Record<string, unknown>);

export function createUserMessageEnvelope<TMessage extends CoreUserMessage>(
  message: TMessage
): {
  kind: typeof chatUserMessageEnvelopeKind;
  message: TMessage;
} {
  return {
    kind: chatUserMessageEnvelopeKind,
    message,
  };
}

export function createAssistantChunkEnvelope<TChunk extends CoreAssistantChunk>(
  chunk: TChunk
): {
  kind: typeof chatAssistantChunkEnvelopeKind;
  chunk: TChunk;
} {
  return {
    kind: chatAssistantChunkEnvelopeKind,
    chunk,
  };
}
