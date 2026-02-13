import { z } from "zod";

/**
 * Generic JSON object shape used for event payloads, metadata, and arbitrary maps.
 */
export const JsonObjectSchema = z.record(z.unknown());

/**
 * Inferred TypeScript type for {@link JsonObjectSchema}.
 */
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/**
 * Event reference metadata used to link events to prior sequences, requests, or steps.
 */
export const EventRefsSchema = z
  .object({
    to_seq: z.number().int().nonnegative().optional(),
    request_id: z.string().optional(),
    sequence_id: z.string().optional(),
    step: z.number().int().nonnegative().optional(),
  })
  .catchall(z.unknown());

/**
 * Inferred TypeScript type for {@link EventRefsSchema}.
 */
export type EventRefs = z.infer<typeof EventRefsSchema>;

/**
 * Request payload for creating a session.
 */
export const CreateSessionInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  metadata: JsonObjectSchema.optional(),
});

/**
 * Inferred TypeScript type for {@link CreateSessionInputSchema}.
 */
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

/**
 * Session record returned by the Starcite API.
 */
export const SessionRecordSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  metadata: JsonObjectSchema,
  last_seq: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Inferred TypeScript type for {@link SessionRecordSchema}.
 */
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * Low-level request payload for appending an event to a session.
 */
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

/**
 * Inferred TypeScript type for {@link AppendEventRequestSchema}.
 */
export type AppendEventRequest = z.infer<typeof AppendEventRequestSchema>;

/**
 * API response returned after appending an event.
 */
export const AppendEventResponseSchema = z.object({
  seq: z.number().int().nonnegative(),
  last_seq: z.number().int().nonnegative(),
  deduped: z.boolean(),
});

/**
 * Inferred TypeScript type for {@link AppendEventResponseSchema}.
 */
export type AppendEventResponse = z.infer<typeof AppendEventResponseSchema>;

/**
 * Raw event frame shape emitted by the Starcite tail stream.
 */
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

/**
 * Inferred TypeScript type for {@link TailEventSchema}.
 */
export type TailEvent = z.infer<typeof TailEventSchema>;

/**
 * Convenience tail event shape with SDK-derived fields (`agent`, `text`).
 */
export const SessionEventSchema = TailEventSchema.extend({
  agent: z.string().optional(),
  text: z.string().optional(),
});

/**
 * Inferred TypeScript type for {@link SessionEventSchema}.
 */
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * High-level `session.append()` input.
 *
 * You must provide either `text` or `payload`.
 */
export const SessionAppendInputSchema = z
  .object({
    agent: z.string().trim().min(1),
    text: z.string().optional(),
    payload: JsonObjectSchema.optional(),
    type: z.string().optional(),
    source: z.string().optional(),
    metadata: JsonObjectSchema.optional(),
    refs: EventRefsSchema.optional(),
    idempotencyKey: z.string().optional(),
    expectedSeq: z.number().int().nonnegative().optional(),
  })
  .refine((value) => !!(value.text || value.payload), {
    message: "append() requires either 'text' or an object 'payload'",
  });

/**
 * Inferred TypeScript type for {@link SessionAppendInputSchema}.
 */
export type SessionAppendInput = z.infer<typeof SessionAppendInputSchema>;

/**
 * Options for streaming events from a session.
 */
export interface SessionTailOptions {
  /**
   * Starting cursor (inclusive) in the event stream.
   */
  cursor?: number;
  /**
   * Optional filter for `agent:<name>` events.
   */
  agent?: string;
  /**
   * Optional abort signal to close the stream.
   */
  signal?: AbortSignal;
}

/**
 * Minimal WebSocket contract required by the SDK.
 */
export interface StarciteWebSocket {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  close(code?: number, reason?: string): void;
}

/**
 * Factory used to create the WebSocket connection for `tail`.
 */
export type StarciteWebSocketFactory = (url: string) => StarciteWebSocket;

/**
 * Client construction options.
 */
export interface StarciteClientOptions {
  /**
   * Base API URL. Defaults to `process.env.STARCITE_BASE_URL` or `http://localhost:4000`.
   */
  baseUrl?: string;
  /**
   * Custom fetch implementation for non-standard runtimes.
   */
  fetch?: typeof fetch;
  /**
   * Headers applied to every HTTP request.
   */
  headers?: HeadersInit;
  /**
   * Custom WebSocket factory for non-browser runtimes.
   */
  websocketFactory?: StarciteWebSocketFactory;
}

/**
 * Error payload shape returned by non-2xx API responses.
 */
export const StarciteErrorPayloadSchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .catchall(z.unknown());

/**
 * Inferred TypeScript type for {@link StarciteErrorPayloadSchema}.
 */
export type StarciteErrorPayload = z.infer<typeof StarciteErrorPayloadSchema>;
