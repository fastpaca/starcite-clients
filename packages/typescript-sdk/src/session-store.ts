import { z } from "zod";
import { StarciteError } from "./errors";
import {
  type AppendEventRequest,
  type SessionAppendStoreState,
  SessionAppendStoreStateSchema,
  type SessionStore,
  type SessionStoreState,
  type TailEvent,
  TailEventSchema,
} from "./types";

const DEFAULT_KEY_PREFIX = "starcite";

const SessionStoreMetadataSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  updatedAtMs: z.number().int().nonnegative(),
});

const SessionStoreStateSchema = z.object({
  cursor: z.number().int().nonnegative(),
  events: z.array(TailEventSchema),
  append: SessionAppendStoreStateSchema.optional(),
  metadata: SessionStoreMetadataSchema.optional(),
});

/**
 * Minimal Web Storage contract used by {@link WebStorageSessionStore}.
 */
export interface StarciteWebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * Key customization options for storage-backed session stores.
 */
export interface SessionStoreOptions {
  /**
   * Prefix used when deriving storage keys.
   *
   * Defaults to `"starcite"`.
   */
  keyPrefix?: string;
  /**
   * Custom key resolver. When provided it overrides `keyPrefix`.
   */
  keyForSession?: (sessionId: string) => string;
}

/**
 * Construction options for {@link WebStorageSessionStore}.
 */
export interface WebStorageSessionStoreOptions<
  TEvent extends TailEvent = TailEvent,
> extends SessionStoreOptions {
  /**
   * Optional schema for validating persisted state payloads.
   *
   * When omitted, a default schema validates canonical TailEvent snapshots.
   */
  stateSchema?: z.ZodType<SessionStoreState<TEvent>>;
}

function cloneEvents<TEvent extends TailEvent>(
  events: readonly TEvent[]
): TEvent[] {
  // Store boundaries should not share mutable arrays across callers.
  return events.map((event) => structuredClone(event) as TEvent);
}

function cloneState<TEvent extends TailEvent>(
  state: SessionStoreState<TEvent>
): SessionStoreState<TEvent> {
  return {
    cursor: state.cursor,
    events: cloneEvents(state.events),
    append: cloneAppendState(state.append),
    metadata: state.metadata ? { ...state.metadata } : undefined,
  };
}

function cloneAppendState(
  state: SessionAppendStoreState | undefined
): SessionAppendStoreState | undefined {
  if (!state) {
    return undefined;
  }

  return {
    producerId: state.producerId,
    lastAcknowledgedProducerSeq: state.lastAcknowledgedProducerSeq,
    status: state.status,
    lastFailure: state.lastFailure ? { ...state.lastFailure } : undefined,
    pending: state.pending.map((append) => {
      return {
        id: append.id,
        request: structuredClone(append.request) as AppendEventRequest,
        enqueuedAtMs: append.enqueuedAtMs,
        retryAttempt: append.retryAttempt,
      };
    }),
  };
}

/**
 * Default in-memory session store.
 *
 * Persists both cursor and retained events for each session so late subscribers
 * can replay immediately after process-local reconnect/rebind.
 */
export class MemoryStore<TEvent extends TailEvent = TailEvent>
  implements SessionStore<TEvent>
{
  private readonly sessions = new Map<string, SessionStoreState<TEvent>>();

  load(sessionId: string): SessionStoreState<TEvent> | undefined {
    const stored = this.sessions.get(sessionId);
    return stored ? cloneState(stored) : undefined;
  }

  save(sessionId: string, state: SessionStoreState<TEvent>): void {
    this.sessions.set(sessionId, cloneState(state));
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * Session store backed by a Web Storage-compatible object.
 */
export class WebStorageSessionStore<TEvent extends TailEvent = TailEvent>
  implements SessionStore<TEvent>
{
  private readonly storage: StarciteWebStorage;
  private readonly keyForSession: (sessionId: string) => string;
  private readonly stateSchema: z.ZodType<SessionStoreState<TEvent>>;

  constructor(
    storage: StarciteWebStorage,
    options: WebStorageSessionStoreOptions<TEvent> = {}
  ) {
    this.storage = storage;
    const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.keyForSession =
      options.keyForSession ??
      ((sessionId) => `${prefix}:${sessionId}:sessionStore`);
    this.stateSchema =
      options.stateSchema ??
      (SessionStoreStateSchema as unknown as z.ZodType<
        SessionStoreState<TEvent>
      >);
  }

  load(sessionId: string): SessionStoreState<TEvent> | undefined {
    const raw = this.storage.getItem(this.keyForSession(sessionId));
    if (raw === null) {
      return undefined;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return undefined;
    }

    const parsed = this.stateSchema.safeParse(decoded);
    if (!parsed.success) {
      return undefined;
    }

    return cloneState(parsed.data);
  }

  save(sessionId: string, state: SessionStoreState<TEvent>): void {
    this.storage.setItem(
      this.keyForSession(sessionId),
      JSON.stringify(cloneState(state))
    );
  }

  clear(sessionId: string): void {
    this.storage.removeItem?.(this.keyForSession(sessionId));
  }
}

/**
 * Session store backed by `globalThis.localStorage`.
 */
export class LocalStorageSessionStore<
  TEvent extends TailEvent = TailEvent,
> extends WebStorageSessionStore<TEvent> {
  constructor(options: WebStorageSessionStoreOptions<TEvent> = {}) {
    if (typeof localStorage === "undefined") {
      throw new StarciteError(
        "localStorage is not available in this runtime. Use WebStorageSessionStore with a custom storage adapter."
      );
    }
    super(localStorage, options);
  }
}
