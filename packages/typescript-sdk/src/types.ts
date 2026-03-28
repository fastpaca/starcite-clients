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
 * Cursor object used by the tail stream.
 */
export const TailWireCursorSchema = z.object({
  epoch: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
});

export type TailWireCursor = z.infer<typeof TailWireCursorSchema>;

/**
 * Tail resume cursor accepted by the SDK.
 */
export const TailCursorSchema = TailWireCursorSchema;

/**
 * User-facing tail cursor input.
 */
export type TailCursor = z.infer<typeof TailCursorSchema>;

/**
 * Tail frame batch size accepted by the SDK.
 */
export const TailBatchSizeSchema = z.number().int().min(1).max(1000);

/**
 * Raw event frame shape emitted by the Starcite tail stream.
 */
export const TailEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  cursor: TailWireCursorSchema.optional(),
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
  /**
   * Optional filter for `agent:<name>` events.
   */
  agent?: string;
}

/**
 * Server-emitted gap payload surfaced by the tail transport.
 */
export const TailGapSchema = z.object({
  type: z.literal("gap"),
  reason: z.enum(["cursor_expired", "epoch_stale", "rollback"]),
  from_cursor: TailWireCursorSchema,
  next_cursor: TailWireCursorSchema,
  committed_cursor: TailWireCursorSchema,
  earliest_available_cursor: TailWireCursorSchema,
});

/**
 * Inferred TypeScript type for {@link TailGapSchema}.
 */
export type TailGap = z.infer<typeof TailGapSchema>;

/**
 * Server-emitted auth expiry signal surfaced by the tail transport.
 */
export const TailTokenExpiredPayloadSchema = z.object({
  reason: z.literal("token_expired"),
});

/**
 * Inferred TypeScript type for {@link TailTokenExpiredPayloadSchema}.
 */
export type TailTokenExpiredPayload = z.infer<
  typeof TailTokenExpiredPayloadSchema
>;

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
   * Highest committed sequence observed for this session.
   */
  lastSeq: number;
  /**
   * Exact tail resume cursor for continuing reconciliation, when available.
   */
  cursor?: TailCursor;
  /**
   * Indicates whether the session is actively streaming tail updates.
   */
  syncing: boolean;
}

export type SessionAppendQueueStatus =
  | "idle"
  | "flushing"
  | "retrying"
  | "paused";

export interface SessionAppendRetryPolicy {
  /**
   * Retry mode. `fixed` uses a constant delay, `exponential` grows the delay between attempts.
   *
   * Defaults to `exponential`.
   */
  mode?: "fixed" | "exponential";
  /**
   * Initial retry delay in milliseconds.
   *
   * Defaults to `250`.
   */
  initialDelayMs?: number;
  /**
   * Maximum retry delay in milliseconds.
   *
   * Defaults to `5000`.
   */
  maxDelayMs?: number;
  /**
   * Exponential growth factor applied after each retry attempt.
   *
   * Defaults to `2`.
   */
  multiplier?: number;
  /**
   * Optional jitter ratio (`0..1`) applied around the computed delay.
   *
   * Defaults to `0`.
   */
  jitterRatio?: number;
  /**
   * Maximum retry attempts before the queue enters terminal handling.
   *
   * Defaults to unlimited retries.
   */
  maxAttempts?: number;
}

export interface SessionAppendOptions {
  /**
   * Retry policy used for transient append failures.
   */
  retryPolicy?: SessionAppendRetryPolicy;
  /**
   * Whether queued appends should be persisted through the configured `SessionStore`.
   *
   * Defaults to `true` when a store is configured.
   */
  persist?: boolean;
  /**
   * Whether persisted pending appends should start flushing automatically when a session is created.
   *
   * Defaults to `true`.
   */
  autoFlush?: boolean;
  /**
   * How the queue should behave after a terminal append failure.
   *
   * `pause` preserves pending appends and blocks later items until the caller
   * resumes or resets the queue. `clear` drops the queue and rotates producer identity.
   *
   * Defaults to `pause`.
   */
  terminalFailureMode?: "pause" | "clear";
}

export interface SessionAppendFailureSnapshot {
  name: string;
  message: string;
  retryable: boolean;
  terminal: boolean;
  occurredAtMs: number;
  status?: number;
  code?: string;
}

export const SessionAppendFailureSnapshotSchema = z.object({
  name: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  terminal: z.boolean(),
  occurredAtMs: z.number().int().nonnegative(),
  status: z.number().int().nonnegative().optional(),
  code: z.string().min(1).optional(),
});

export interface SessionPendingAppend {
  id: string;
  request: AppendEventRequest;
  enqueuedAtMs: number;
  retryAttempt: number;
}

export interface SessionAppendQueueState {
  status: SessionAppendQueueStatus;
  producerId: string;
  lastAcknowledgedProducerSeq: number;
  pending: SessionPendingAppend[];
  inFlightItemId?: string;
  retryAttempt?: number;
  nextRetryAtMs?: number;
  lastFailure?: SessionAppendFailureSnapshot;
}

export type SessionAppendLifecycleEvent =
  | {
      type: "queued";
      sessionId: string;
      item: SessionPendingAppend;
      queue: SessionAppendQueueState;
    }
  | {
      type: "attempt_started";
      sessionId: string;
      itemId: string;
      attempt: number;
      queue: SessionAppendQueueState;
    }
  | {
      type: "retry_scheduled";
      sessionId: string;
      itemId: string;
      attempt: number;
      delayMs: number;
      failure: SessionAppendFailureSnapshot;
      queue: SessionAppendQueueState;
    }
  | {
      type: "acknowledged";
      sessionId: string;
      itemId: string;
      seq: number;
      deduped: boolean;
      queue: SessionAppendQueueState;
    }
  | {
      type: "paused";
      sessionId: string;
      itemId: string;
      failure: SessionAppendFailureSnapshot;
      queue: SessionAppendQueueState;
    }
  | {
      type: "cleared";
      sessionId: string;
      itemId: string;
      failure: SessionAppendFailureSnapshot;
      queue: SessionAppendQueueState;
    }
  | {
      type: "resumed";
      sessionId: string;
      queue: SessionAppendQueueState;
    }
  | {
      type: "reset";
      sessionId: string;
      queue: SessionAppendQueueState;
    };

export type SessionAppendListener = (
  event: SessionAppendLifecycleEvent
) => void | Promise<void>;

/**
 * Listener invoked when the server reports an explicit tail gap.
 */
export type SessionGapListener = (gap: TailGap) => void | Promise<void>;

export const SessionStoredAppendSchema = z.object({
  id: z.string().min(1),
  request: AppendEventRequestSchema,
  enqueuedAtMs: z.number().int().nonnegative(),
  retryAttempt: z.number().int().nonnegative().optional().default(0),
});

export type SessionStoredAppend = z.infer<typeof SessionStoredAppendSchema>;

export const SessionAppendStoreStateSchema = z.object({
  producerId: z.string().min(1),
  lastAcknowledgedProducerSeq: z.number().int().nonnegative(),
  pending: z.array(SessionStoredAppendSchema),
  status: z.enum(["idle", "paused"]).optional(),
  lastFailure: SessionAppendFailureSnapshotSchema.optional(),
});

export type SessionAppendStoreState = z.infer<
  typeof SessionAppendStoreStateSchema
>;

/**
 * Serializable persisted state for one session log.
 */
export interface SessionStoreMetadata {
  /**
   * Store payload schema version.
   */
  schemaVersion: 4;
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
   * Highest committed sequence observed for this session.
   */
  lastSeq: number;
  /**
   * Exact tail resume cursor for continuing replay.
   */
  cursor?: TailCursor;
  /**
   * Retained committed events snapshot used for immediate replay.
   */
  events: TEvent[];
  /**
   * Optional persisted append queue + producer state.
   */
  append?: SessionAppendStoreState;
  /**
   * Optional metadata for versioning and operational introspection.
   */
  metadata?: SessionStoreMetadata;
}

/**
 * Persistence interface for session resume state + retained events.
 */
export interface SessionStore<TEvent extends TailEvent = TailEvent> {
  load(sessionId: string): SessionStoreState<TEvent> | undefined;
  save(sessionId: string, state: SessionStoreState<TEvent>): void;
  clear?(sessionId: string): void;
}

/**
 * High-level `session.append()` input.
 *
 * The SDK manages `producer_id` and `producer_seq` automatically.
 * Provide `text` or `payload`, and optionally override `actor`.
 */
export const SessionAppendInputSchema = z
  .object({
    text: z.string().optional(),
    payload: ArbitraryObjectSchema.optional(),
    type: z.string().optional(),
    actor: z.string().min(1).optional(),
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
 * Options for listing sessions.
 */
export const SessionListOptionsSchema = z.object({
  limit: z.number().int().positive().optional(),
  cursor: z.string().min(1).optional(),
  metadata: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export type SessionListOptions = z.input<typeof SessionListOptionsSchema>;

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
   * Service key / JWT token used for authenticated backend requests.
   */
  apiKey?: string;
  /**
   * Auth issuer URL used to mint session tokens. When omitted, the SDK derives
   * this from API key JWT `iss` (issuer authority) or `STARCITE_AUTH_URL`.
   */
  authUrl?: string;
  /**
   * Optional session store used for resume state + retained event persistence.
   *
   * When omitted, fresh attaches replay from the start of the server tail.
   */
  store?: SessionStore;
  /**
   * Default append queue behavior for sessions created by this client.
   */
  appendOptions?: SessionAppendOptions;
}

/**
 * Live tenant-scoped lifecycle event emitted by `starcite.on(...)`.
 */
export const LifecycleEventEnvelopeSchema = z
  .object({
    kind: z.string().min(1),
  })
  .passthrough();

export const SessionCreatedLifecycleEventSchema = z.object({
  kind: z.literal("session.created"),
  session_id: z.string().min(1),
  tenant_id: z.string().min(1),
  title: z.string().nullable().optional(),
  metadata: ArbitraryObjectSchema,
  created_at: z.string().min(1),
});

export type SessionCreatedLifecycleEvent = z.infer<
  typeof SessionCreatedLifecycleEventSchema
>;

/**
 * Error payload shape returned by non-2xx API responses.
 */
export type StarciteErrorPayload = Record<string, unknown>;
