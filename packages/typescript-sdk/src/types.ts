import { z } from "zod";

export const JsonObjectSchema = z.record(z.unknown());

export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const EventRefsSchema = z
  .object({
    to_seq: z.number().int().nonnegative().optional(),
    request_id: z.string().optional(),
    sequence_id: z.string().optional(),
    step: z.number().int().nonnegative().optional(),
  })
  .catchall(z.unknown());

export type EventRefs = z.infer<typeof EventRefsSchema>;

export const CreateSessionInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  metadata: JsonObjectSchema.optional(),
});

export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const SessionRecordSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  metadata: JsonObjectSchema,
  last_seq: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const AppendEventRequestSchema = z.object({
  type: z.string().min(1),
  payload: JsonObjectSchema,
  actor: z.string().min(1),
  source: z.string().optional(),
  metadata: JsonObjectSchema.optional(),
  refs: EventRefsSchema.optional(),
  idempotency_key: z.string().optional(),
  expected_seq: z.number().int().nonnegative().optional(),
});

export type AppendEventRequest = z.infer<typeof AppendEventRequestSchema>;

export const AppendEventResponseSchema = z.object({
  seq: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
  deduped: z.boolean(),
});

export type AppendEventResponse = z.infer<typeof AppendEventResponseSchema>;

export const TailEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  payload: JsonObjectSchema,
  actor: z.string().min(1),
  source: z.string().optional(),
  metadata: JsonObjectSchema.optional(),
  refs: EventRefsSchema.optional(),
  idempotency_key: z.string().nullable().optional(),
  inserted_at: z.string().optional(),
});

export type TailEvent = z.infer<typeof TailEventSchema>;

export const SessionEventSchema = TailEventSchema.extend({
  agent: z.string().optional(),
  text: z.string().optional(),
});

export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const SessionAppendInputSchema = z.object({
  agent: z.string(),
  text: z.string().optional(),
  payload: JsonObjectSchema.optional(),
  type: z.string().optional(),
  source: z.string().optional(),
  metadata: JsonObjectSchema.optional(),
  refs: EventRefsSchema.optional(),
  idempotencyKey: z.string().optional(),
  expectedSeq: z.number().int().nonnegative().optional(),
});

export type SessionAppendInput = z.infer<typeof SessionAppendInputSchema>;

export interface SessionTailOptions {
  cursor?: number;
  agent?: string;
  signal?: AbortSignal;
}

export interface StarciteWebSocket {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  close(code?: number, reason?: string): void;
}

export type StarciteWebSocketFactory = (url: string) => StarciteWebSocket;

export interface StarciteClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  websocketFactory?: StarciteWebSocketFactory;
}

export const StarciteErrorPayloadSchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .catchall(z.unknown());

export type StarciteErrorPayload = z.infer<typeof StarciteErrorPayloadSchema>;
