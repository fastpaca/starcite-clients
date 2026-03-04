import { z } from "zod";
import {
  SessionCreatorPrincipalSchema as SessionCreatorPrincipalSchemaValue,
  SessionTokenPrincipalSchema as SessionTokenPrincipalSchemaValue,
} from "./identity";

export const SessionCreatorPrincipalSchema = SessionCreatorPrincipalSchemaValue;
export const SessionTokenPrincipalSchema = SessionTokenPrincipalSchemaValue;

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
 * High-level append result returned by `session.append()`.
 */
export interface AppendResult {
  seq: number;
  deduped: boolean;
}

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
 * Canonical session event surfaced by the SDK.
 */
export type SessionEvent = TailEvent;

/**
 * Listener dispatch phase for `session.on("event")`.
 */
export type SessionEventPhase = "replay" | "live";

/**
 * Context passed to `session.on("event")` listeners.
 */
export interface SessionEventContext {
  /**
   * Indicates whether this event originated from retained replay or live tail sync.
   */
  phase: SessionEventPhase;
  /**
   * Convenience flag for `phase === "replay"`.
   */
  replayed: boolean;
}

/**
 * Session event listener signature.
 */
export type SessionEventListener<TEvent extends SessionEvent = SessionEvent> = (
  event: TEvent,
  context: SessionEventContext
) => void | Promise<void>;

/**
 * Item yielded by `session.tail(...)` async iterators.
 */
export interface SessionTailItem<TEvent extends SessionEvent = SessionEvent> {
  /**
   * Canonical ordered event.
   */
  event: TEvent;
  /**
   * Replay/live classification for this event.
   */
  context: SessionEventContext;
}

/**
 * Listener options for `session.on("event", ...)`.
 */
export interface SessionOnEventOptions<
  TEvent extends SessionEvent = SessionEvent,
> {
  /**
   * Whether retained in-memory events should be replayed to this listener.
   *
   * Defaults to `true`.
   */
  replay?: boolean;
  /**
   * Optional schema used to validate and narrow events before dispatch.
   *
   * Schema validation failures are surfaced as session `error` events.
   */
  schema?: z.ZodType<TEvent>;
}

/**
 * Options for async iterator tails.
 */
export interface SessionTailIteratorOptions<
  TEvent extends SessionEvent = SessionEvent,
> extends SessionTailOptions,
    SessionOnEventOptions<TEvent> {}
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
 * Serializable persisted state for one session log.
 */
export interface SessionStoreMetadata {
  /**
   * Store payload schema version.
   */
  schemaVersion: 1;
  /**
   * Unix epoch milliseconds when this snapshot was written.
   */
  updatedAtMs: number;
}

/**
 * Serializable persisted state for one session log.
 */
export interface SessionStoreState<TEvent extends TailEvent = TailEvent> {
  /**
   * Highest contiguous sequence applied for this session.
   */
  cursor: number;
  /**
   * Retained events snapshot used for immediate replay.
   */
  events: TEvent[];
  /**
   * Optional metadata for versioning and operational introspection.
   */
  metadata?: SessionStoreMetadata;
}

/**
 * Persistence interface for session cursor + retained events.
 */
export interface SessionStore<TEvent extends TailEvent = TailEvent> {
  load(sessionId: string): SessionStoreState<TEvent> | undefined;
  save(sessionId: string, state: SessionStoreState<TEvent>): void;
  clear?(sessionId: string): void;
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
   * Defaults to `12000`.
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
export type StarciteWebSocketFactory = (url: string) => StarciteWebSocket;

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
   * `Authorization: Bearer <token>` for HTTP requests.
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
   * Optional session store used for cursor + retained event persistence.
   *
   * When omitted, fresh attaches start from cursor `0` and replay from server tail.
   */
  store?: SessionStore;
}

/**
 * Error payload shape returned by non-2xx API responses.
 */
export type StarciteErrorPayload = Record<string, unknown>;
