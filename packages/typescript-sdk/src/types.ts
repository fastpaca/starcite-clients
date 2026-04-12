import { z } from "zod";

const ArbitraryObjectSchema = z.record(z.unknown());

export interface IssueSessionTokenInput {
  session_id: string;
  principal: { type: "user" | "agent"; id: string };
  scopes: ("session:read" | "session:append")[];
  ttl_seconds?: number;
}

/**
 * Response payload returned by the auth issuer service when minting a session token.
 */
export const IssueSessionTokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

/**
 * Session record returned by the Starcite API.
 */
export const SessionRecordSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  metadata: ArbitraryObjectSchema,
  last_seq: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
  tenant_id: z.string().min(1).optional(),
  creator_principal: z
    .object({
      tenant_id: z.string().min(1),
      id: z.string().min(1),
      type: z.string().min(1),
    })
    .optional(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number().int().positive().optional(),
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
  archived: z.boolean().optional(),
  updated_at: z.string().optional(),
  version: z.number().int().positive().optional(),
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
 * Tail resume cursor accepted by the SDK.
 */
export const TailCursorSchema = z.number().int().nonnegative();

/**
 * User-facing tail cursor input.
 */
export type TailCursor = z.infer<typeof TailCursorSchema>;

/**
 * Raw event frame shape emitted by the Starcite tail stream.
 */
export const TailEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  cursor: TailCursorSchema.optional(),
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
}

/**
 * Session event listener signature.
 */
export type SessionEventListener<TEvent extends TailEvent = TailEvent> = (
  event: TEvent,
  context: SessionEventContext
) => void | Promise<void>;

/**
 * Listener options for `session.on("event", ...)`.
 */
export interface SessionOnEventOptions<TEvent extends TailEvent = TailEvent> {
  /**
   * Whether locally materialized in-memory events should be replayed to this listener.
   *
   * Defaults to `false`.
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
 * Narrow public session surface for direct consumers and integrations.
 */
export interface SessionHandle {
  readonly id: string;
  append(input: SessionAppendInput): Promise<AppendResult>;
  range(
    fromSeq: number,
    toSeq: number,
    requestOptions?: RequestOptions
  ): Promise<readonly TailEvent[]>;
  state(): SessionSnapshot;
  on(
    eventName: "event",
    listener: SessionEventListener,
    options?: SessionOnEventOptions<TailEvent>
  ): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
}

/**
 * Server-emitted gap payload surfaced by the tail transport.
 */
export const TailGapSchema = z.object({
  type: z.literal("gap"),
  reason: z.enum(["cursor_expired", "resume_invalidated"]),
  from_cursor: TailCursorSchema,
  next_cursor: TailCursorSchema,
  committed_cursor: TailCursorSchema,
  earliest_available_cursor: TailCursorSchema,
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

export type SessionAttachMode = "on-demand" | "eager";

/**
 * Snapshot of a session's canonical in-memory log state.
 */
export interface SessionSnapshot {
  /**
   * Ordered events currently materialized in memory.
   *
   * This can be a sparse subset of the full session history.
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
  /**
   * Current local append outbox state for this session.
   */
  append?: SessionAppendQueueState;
}

export type SessionTokenRefreshReason =
  | "manual"
  | "token_expired"
  | "unauthorized";

export interface SessionTokenRefreshContext {
  /**
   * Session being reauthenticated.
   */
  sessionId: string;
  /**
   * The currently bound session token when refresh started.
   */
  token: string;
  /**
   * Why the SDK is asking for a new token.
   */
  reason: SessionTokenRefreshReason;
  /**
   * Optional triggering error when refresh was caused by a failed operation.
   */
  error?: Error;
}

export type SessionTokenRefreshHandler = (
  context: SessionTokenRefreshContext
) => string | Promise<string>;

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
   * Whether queued appends should be persisted through the configured session cache.
   *
   * Defaults to `true` when a cache is configured.
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
 * Serializable sparse coverage range for one materialized session history.
 */
export interface SessionHistoryRangeCheckpoint {
  /**
   * First covered sequence in this materialized range.
   */
  fromSeq: number;
  /**
   * Last covered sequence in this materialized range.
   */
  toSeq: number;
  /**
   * Replay cursor immediately before `fromSeq`, when known.
   */
  beforeCursor?: TailCursor;
  /**
   * Replay cursor at `toSeq`, when known.
   */
  afterCursor?: TailCursor;
}

/**
 * Serializable checkpoint for one materialized session history.
 */
export interface SessionHistoryCheckpoint {
  /**
   * Highest committed sequence observed for this session.
   */
  lastSeq: number;
  /**
   * Exact tail resume cursor for continuing replay.
   */
  cursor?: TailCursor;
  /**
   * Sparse materialized events retained locally.
   */
  events?: TailEvent[];
  /**
   * Exact seq coverage of the retained sparse events.
   */
  ranges?: SessionHistoryRangeCheckpoint[];
}

/**
 * Operational metadata for one persisted cache entry.
 */
export interface SessionCacheMetadata {
  /**
   * Cache entry schema version.
   */
  schemaVersion: 5 | 6 | 7;
  /**
   * Unix epoch milliseconds when this entry was written.
   */
  cachedAtMs: number;
}

/**
 * Persisted cache entry for one session.
 */
export interface SessionCacheEntry {
  /**
   * Optional warm-start checkpoint for the session history.
   */
  history?: SessionHistoryCheckpoint;
  /**
   * Legacy warm-start checkpoint for the session log.
   */
  log?: SessionHistoryCheckpoint;
  /**
   * Optional persisted append outbox + producer state.
   */
  outbox?: SessionAppendStoreState;
  /**
   * Optional metadata for versioning and operational introspection.
   */
  metadata?: SessionCacheMetadata;
}

/**
 * Persistence interface for session resume cursor + append outbox state.
 */
export interface SessionCache {
  read(sessionId: string): SessionCacheEntry | undefined;
  write(sessionId: string, entry: SessionCacheEntry): void;
  clear?(sessionId: string): void;
}

/**
 * High-level `session.append()` input.
 *
 * The SDK manages `producer_id` and `producer_seq` automatically.
 * Provide `text` or `payload`, and optionally override `actor`.
 */
export interface SessionAppendInput {
  text?: string;
  payload?: Record<string, unknown>;
  type?: string;
  actor?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  refs?: Record<string, unknown>;
  idempotencyKey?: string;
  expectedSeq?: number;
}

/**
 * Options for listing sessions.
 */
export interface SessionListOptions {
  limit?: number;
  cursor?: string;
  archived?: SessionArchivedFilter;
  metadata?: Record<string, string>;
}

export type SessionArchivedFilter = boolean | "all";

export interface SessionUpdateInput {
  title?: string | null;
  metadata?: Record<string, unknown>;
  expectedVersion?: number;
}

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
   * Optional session cache used for resume state + append outbox persistence.
   *
   * When omitted, sessions start without a durable local cursor.
   */
  cache?: SessionCache;
  /**
   * Whether sessions should attach the tail channel immediately on construction.
   *
   * Defaults to `"on-demand"`, which waits until listeners or pending appends
   * need live sync.
   */
  sessionAttachMode?: SessionAttachMode;
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

export type LifecycleEventEnvelope = z.infer<
  typeof LifecycleEventEnvelopeSchema
>;

export const SessionLifecycleEventNames = [
  "session.created",
  "session.updated",
  "session.archived",
  "session.unarchived",
  "session.hydrating",
  "session.activated",
  "session.freezing",
  "session.frozen",
] as const;

export const SessionLifecycleEventNameSchema = z.enum(
  SessionLifecycleEventNames
);

const SessionLifecycleBaseSchema = z.object({
  session_id: z.string().min(1),
  tenant_id: z.string().min(1),
});

export const SessionCreatedLifecycleEventSchema =
  SessionLifecycleBaseSchema.extend({
    kind: z.literal("session.created"),
    title: z.string().nullable().optional(),
    metadata: ArbitraryObjectSchema,
    created_at: z.string().min(1),
    version: z.number().int().positive().optional(),
  });

export const SessionUpdatedLifecycleEventSchema =
  SessionLifecycleBaseSchema.extend({
    kind: z.literal("session.updated"),
    title: z.string().nullable().optional(),
    metadata: ArbitraryObjectSchema,
    updated_at: z.string().min(1),
    version: z.number().int().positive().optional(),
  });

export const SessionArchivedLifecycleEventSchema =
  SessionLifecycleBaseSchema.extend({
    kind: z.literal("session.archived"),
    archived: z.literal(true),
  });

export const SessionUnarchivedLifecycleEventSchema =
  SessionLifecycleBaseSchema.extend({
    kind: z.literal("session.unarchived"),
    archived: z.literal(false),
  });

export const SessionHydratingLifecycleEventSchema =
  SessionLifecycleBaseSchema.extend({
    kind: z.literal("session.hydrating"),
  });

export const SessionActivatedLifecycleEventSchema =
  SessionLifecycleBaseSchema.extend({
    kind: z.literal("session.activated"),
  });

export const SessionFreezingLifecycleEventSchema =
  SessionLifecycleBaseSchema.extend({
    kind: z.literal("session.freezing"),
  });

export const SessionFrozenLifecycleEventSchema =
  SessionLifecycleBaseSchema.extend({
    kind: z.literal("session.frozen"),
  });

export const SessionLifecycleEventSchema = z.discriminatedUnion("kind", [
  SessionCreatedLifecycleEventSchema,
  SessionUpdatedLifecycleEventSchema,
  SessionArchivedLifecycleEventSchema,
  SessionUnarchivedLifecycleEventSchema,
  SessionHydratingLifecycleEventSchema,
  SessionActivatedLifecycleEventSchema,
  SessionFreezingLifecycleEventSchema,
  SessionFrozenLifecycleEventSchema,
]);

/**
 * Currently modeled lifecycle payloads surfaced through typed named listeners
 * such as `starcite.on("session.created", ...)`.
 */
export type SessionLifecycleEvent = z.infer<typeof SessionLifecycleEventSchema>;

export type SessionLifecycleEventName = z.infer<
  typeof SessionLifecycleEventNameSchema
>;

export type SessionLifecycleEventFor<K extends SessionLifecycleEventName> =
  Extract<SessionLifecycleEvent, { kind: K }>;

export type SessionLifecycleEventListeners = {
  [K in SessionLifecycleEventName]: (
    event: SessionLifecycleEventFor<K>
  ) => void;
};

export type SessionCreatedLifecycleEvent = z.infer<
  typeof SessionCreatedLifecycleEventSchema
>;

export type SessionUpdatedLifecycleEvent = z.infer<
  typeof SessionUpdatedLifecycleEventSchema
>;

export type SessionArchivedLifecycleEvent = z.infer<
  typeof SessionArchivedLifecycleEventSchema
>;

export type SessionUnarchivedLifecycleEvent = z.infer<
  typeof SessionUnarchivedLifecycleEventSchema
>;

export type SessionHydratingLifecycleEvent = z.infer<
  typeof SessionHydratingLifecycleEventSchema
>;

export type SessionActivatedLifecycleEvent = z.infer<
  typeof SessionActivatedLifecycleEventSchema
>;

export type SessionFreezingLifecycleEvent = z.infer<
  typeof SessionFreezingLifecycleEventSchema
>;

export type SessionFrozenLifecycleEvent = z.infer<
  typeof SessionFrozenLifecycleEventSchema
>;
