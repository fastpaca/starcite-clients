import { z } from "zod";
import {
  SessionCreatorPrincipalSchema,
  SessionTokenPrincipalSchema,
} from "./identity";

export { SessionCreatorPrincipalSchema, SessionTokenPrincipalSchema };

const ArbitraryObjectSchema = z.record(z.unknown());

const SessionTokenScopeSchema = z.enum(["session:read", "session:append"]);

export type SessionTokenScope = z.infer<typeof SessionTokenScopeSchema>;

/**
 * Request payload for minting a session token from the auth issuer service.
 */
export const IssueSessionTokenInputSchema = z.object({
  session_id: z.string().min(1),
  principal: SessionTokenPrincipalSchema,
  scopes: z.array(SessionTokenScopeSchema).min(1),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60)
    .optional(),
});

export type IssueSessionTokenInput = z.infer<
  typeof IssueSessionTokenInputSchema
>;

/**
 * Response payload returned by the auth issuer service when minting a session token.
 */
export const IssueSessionTokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

export type IssueSessionTokenResponse = z.infer<
  typeof IssueSessionTokenResponseSchema
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
  actor: z.string().min(1).optional(),
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
 * Raw tail event batch grouped by a single WebSocket frame.
 */
export type TailEventBatch = TailEvent[];

/**
 * Retention options for a session's in-memory canonical log.
 */
export interface SessionLogOptions {
  /**
   * Maximum number of events retained in memory.
   *
   * When omitted, the log keeps all applied events for the current runtime.
   */
  maxEvents?: number;
}

/**
 * Snapshot of a session's canonical in-memory log state.
 */
export interface SessionSnapshot {
  /**
   * Ordered events currently retained in memory.
   */
  events: TailEvent[];
  /**
   * Highest contiguous sequence applied to the log.
   */
  lastSeq: number;
  /**
   * Indicates whether the session is actively streaming tail updates.
   */
  syncing: boolean;
}

/**
 * High-level `session.append()` input.
 *
 * The SDK manages `actor`, `producer_id`, and `producer_seq` automatically.
 * Just provide `text` or `payload`.
 */
export const SessionAppendInputSchema = z
  .object({
    text: z.string().optional(),
    payload: ArbitraryObjectSchema.optional(),
    type: z.string().optional(),
    actor: z.string().trim().min(1).optional(),
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
   * Tail frame batch size (`1..1000`).
   *
   * When greater than `1`, Starcite may emit batched WebSocket frames.
   */
  batchSize?: number;
  /**
   * Optional filter for `agent:<name>` events.
   */
  agent?: string;
  /**
   * Idle window in milliseconds used for replay-only tails (`follow=false`) before auto-close.
   *
   * Defaults to `1000`.
   */
  catchUpIdleMs?: number;
  /**
   * Automatically reconnect on transport failures and continue from the last observed sequence.
   *
   * Defaults to `true`.
   */
  reconnect?: boolean;
  /**
   * Reconnect policy for transport failures.
   */
  reconnectPolicy?: TailReconnectPolicy;
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
  /**
   * Maximum number of tail batches buffered in-memory while the consumer is busy.
   *
   * Defaults to `1024`. When exceeded, the stream fails with `StarciteTailError`.
   */
  maxBufferedBatches?: number;
  /**
   * Optional lifecycle callback invoked for reconnect/drop/terminal stream state changes.
   */
  onLifecycleEvent?: (event: TailLifecycleEvent) => void;
  /**
   * Maximum time to wait for websocket handshake/open before reconnecting or failing.
   *
   * Defaults to `4000`.
   */
  connectionTimeoutMs?: number;
  /**
   * Optional inactivity watchdog. When set, the stream reconnects when no messages
   * arrive within this duration.
   */
  inactivityTimeoutMs?: number;
}

/**
 * Tail reconnect tuning knobs.
 */
export interface TailReconnectPolicy {
  /**
   * Reconnect mode. `fixed` retries at the same delay, `exponential` increases delay after repeated failures.
   *
   * Defaults to `exponential`.
   */
  mode?: "fixed" | "exponential";
  /**
   * Initial reconnect delay in milliseconds.
   *
   * Defaults to `500`.
   */
  initialDelayMs?: number;
  /**
   * Maximum reconnect delay in milliseconds.
   *
   * Defaults to `15000`.
   */
  maxDelayMs?: number;
  /**
   * Exponential growth factor applied after each failed reconnect attempt.
   *
   * Defaults to `2`.
   */
  multiplier?: number;
  /**
   * Optional jitter ratio (`0..1`) applied around the computed delay.
   *
   * Defaults to `0.2`.
   */
  jitterRatio?: number;
  /**
   * Maximum number of reconnect attempts before failing.
   *
   * Defaults to unlimited retries.
   */
  maxAttempts?: number;
}

/**
 * Stream lifecycle event emitted by `tail*()` APIs.
 */
export type TailLifecycleEvent =
  | {
      type: "connect_attempt";
      sessionId: string;
      attempt: number;
      cursor: number;
    }
  | {
      type: "reconnect_scheduled";
      sessionId: string;
      attempt: number;
      delayMs: number;
      trigger: "connect_failed" | "dropped";
      closeCode?: number;
      closeReason?: string;
    }
  | {
      type: "stream_dropped";
      sessionId: string;
      attempt: number;
      closeCode?: number;
      closeReason?: string;
    }
  | {
      type: "stream_ended";
      sessionId: string;
      reason: "aborted" | "caught_up" | "graceful";
    };

/**
 * Storage adapter used by `session.consume*()` to persist the last processed cursor.
 */
export interface SessionCursorStore {
  /**
   * Loads the last processed cursor for a session.
   *
   * Return `undefined` when no cursor has been stored yet.
   */
  load(sessionId: string): number | undefined | Promise<number | undefined>;
  /**
   * Persists the last processed cursor for a session.
   */
  save(sessionId: string, cursor: number): void | Promise<void>;
}

/**
 * Durable tail consumption options with automatic cursor checkpointing.
 */
export interface SessionConsumeOptions
  extends Omit<SessionTailOptions, "cursor"> {
  /**
   * Optional explicit starting cursor. When omitted, the SDK loads it from `cursorStore`.
   */
  cursor?: number;
  /**
   * Cursor storage adapter used for resume-safe processing.
   */
  cursorStore: SessionCursorStore;
  /**
   * Event handler. The cursor is checkpointed only after this handler succeeds.
   */
  handler: (event: TailEvent) => void | Promise<void>;
}

/**
 * Options for listing sessions.
 */
export const SessionListOptionsSchema = z.object({
  limit: z.number().int().positive().optional(),
  cursor: z.string().trim().min(1).optional(),
  metadata: z
    .record(z.string().trim().min(1), z.string().trim().min(1))
    .optional(),
});

export type SessionListOptions = z.input<typeof SessionListOptionsSchema>;

/**
 * Minimal WebSocket contract required by the SDK.
 */
export interface StarciteWebSocketMessageEvent {
  data: unknown;
}

export interface StarciteWebSocketCloseEvent {
  code?: number;
  reason?: string;
}

export interface StarciteWebSocketEventMap {
  open: unknown;
  message: StarciteWebSocketMessageEvent;
  error: unknown;
  close: StarciteWebSocketCloseEvent;
}

export interface StarciteWebSocket {
  addEventListener<TType extends keyof StarciteWebSocketEventMap>(
    type: TType,
    listener: (event: StarciteWebSocketEventMap[TType]) => void
  ): void;
  removeEventListener<TType extends keyof StarciteWebSocketEventMap>(
    type: TType,
    listener: (event: StarciteWebSocketEventMap[TType]) => void
  ): void;
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

export type StarciteWebSocketAuthTransport = "auto" | "header" | "access_token";

/**
 * Options forwarded to individual HTTP requests.
 */
export interface RequestOptions {
  /**
   * Optional abort signal to cancel the request.
   */
  signal?: AbortSignal;
}

/**
 * Client construction options.
 */
export interface StarciteOptions {
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
   * Auth issuer URL used to mint session tokens. When omitted, the SDK derives
   * this from API key JWT `iss` (issuer authority) or `STARCITE_AUTH_URL`.
   */
  authUrl?: string;
  /**
   * Custom WebSocket factory for non-browser runtimes.
   */
  websocketFactory?: StarciteWebSocketFactory;
  /**
   * Tail WebSocket authentication transport.
   *
   * - `auto` (default): use `access_token` query auth for the default factory and
   *   header auth when a custom factory is supplied.
   * - `header`: send `Authorization: Bearer <token>` during upgrade.
   * - `access_token`: send token via `access_token` query parameter.
   */
  websocketAuthTransport?: StarciteWebSocketAuthTransport;
}

/**
 * Error payload shape returned by non-2xx API responses.
 */
export type StarciteErrorPayload = Record<string, unknown>;
