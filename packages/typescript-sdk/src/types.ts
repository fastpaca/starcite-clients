import { z } from "zod";

const ArbitraryObjectSchema = z.record(z.unknown());

const CreatorTypeSchema = z.union([z.literal("user"), z.literal("agent")]);

export const SessionCreatorPrincipalSchema = z.object({
  tenant_id: z.string().min(1),
  id: z.string().min(1),
  type: CreatorTypeSchema,
});

export type SessionCreatorPrincipal = z.infer<
  typeof SessionCreatorPrincipalSchema
>;

/**
 * Request payload for creating a session.
 */
export const CreateSessionInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  metadata: ArbitraryObjectSchema.optional(),
  creator_principal: SessionCreatorPrincipalSchema.optional(),
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
  metadata: ArbitraryObjectSchema,
  last_seq: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Inferred TypeScript type for {@link SessionRecordSchema}.
 */
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * Session item returned by the list endpoint.
 */
export const SessionListItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  metadata: ArbitraryObjectSchema,
  created_at: z.string(),
});

/**
 * Inferred TypeScript type for {@link SessionListItemSchema}.
 */
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

/**
 * Paginated session list response.
 */
export const SessionListPageSchema = z.object({
  sessions: z.array(SessionListItemSchema),
  next_cursor: z.string().nullable(),
});

/**
 * Inferred TypeScript type for {@link SessionListPageSchema}.
 */
export type SessionListPage = z.infer<typeof SessionListPageSchema>;

/**
 * Low-level request payload for appending an event to a session.
 */
export const AppendEventRequestSchema = z.object({
  type: z.string().min(1),
  payload: ArbitraryObjectSchema,
  actor: z.string().min(1),
  producer_id: z.string().min(1),
  producer_seq: z.number().int().positive(),
  source: z.string().optional(),
  metadata: ArbitraryObjectSchema.optional(),
  refs: ArbitraryObjectSchema.optional(),
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
  payload: ArbitraryObjectSchema,
  actor: z.string().min(1),
  producer_id: z.string().min(1),
  producer_seq: z.number().int().positive(),
  source: z.string().optional(),
  metadata: ArbitraryObjectSchema.optional(),
  refs: ArbitraryObjectSchema.optional(),
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
const SessionEventInternalSchema = TailEventSchema.extend({
  agent: z.string().optional(),
  text: z.string().optional(),
});

/**
 * Inferred TypeScript type for the SDK-level enriched tail event.
 */
export type SessionEvent = z.infer<typeof SessionEventInternalSchema>;

/**
 * High-level `session.append()` input.
 *
 * You must provide producer identity (`producerId`, `producerSeq`) and either
 * `text` or `payload`.
 */
export const SessionAppendInputSchema = z
  .object({
    agent: z.string().trim().min(1),
    producerId: z.string().trim().min(1),
    producerSeq: z.number().int().positive(),
    text: z.string().optional(),
    payload: ArbitraryObjectSchema.optional(),
    type: z.string().optional(),
    source: z.string().optional(),
    metadata: ArbitraryObjectSchema.optional(),
    refs: ArbitraryObjectSchema.optional(),
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
   * Automatically reconnect on transport failures and continue from the last observed sequence.
   *
   * Defaults to `true`.
   */
  reconnect?: boolean;
  /**
   * Delay between reconnect attempts in milliseconds.
   *
   * Defaults to `3000`.
   */
  reconnectDelayMs?: number;
  /**
   * When `false`, exit after replaying stored events instead of streaming live.
   *
   * Defaults to `true`.
   */
  follow?: boolean;
  /**
   * Optional abort signal to close the stream.
   */
  signal?: AbortSignal;
}

/**
 * Options for listing sessions.
 */
export interface SessionListOptions {
  /**
   * Maximum rows to return. Must be a positive integer.
   */
  limit?: number;
  /**
   * Optional cursor from the previous response.
   */
  cursor?: string;
  /**
   * Optional flat metadata exact-match filters.
   */
  metadata?: Record<string, string>;
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
export interface StarciteWebSocketConnectOptions {
  /**
   * Headers to include with the WebSocket handshake request.
   */
  headers?: HeadersInit;
}

/**
 * Factory used to create the WebSocket connection for `tail`.
 */
export type StarciteWebSocketFactory = (
  url: string,
  options?: StarciteWebSocketConnectOptions
) => StarciteWebSocket;

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
   * Service key / JWT token. When set, the SDK automatically sends
   * `Authorization: Bearer <token>` for HTTP requests and WebSocket upgrades.
   */
  apiKey?: string;
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
