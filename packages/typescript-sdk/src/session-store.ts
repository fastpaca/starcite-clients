import { z } from "zod";
import { StarciteError } from "./errors";
import type { SessionHistoryStoreSnapshot } from "./session-history";
import {
  SessionAppendStoreStateSchema,
  type SessionStore,
  TailCursorSchema,
  TailEventSchema,
} from "./types";

const SESSION_STORE_VERSION = 2;

const SessionHistoryCoverageSchema = z.object({
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
  beforeCursor: TailCursorSchema.optional(),
  afterCursor: TailCursorSchema.optional(),
});

const StoredSessionStateSchema = z.object({
  version: z.literal(SESSION_STORE_VERSION),
  lastSeq: z.number().int().nonnegative(),
  cursor: TailCursorSchema.optional(),
  events: z.array(TailEventSchema).optional(),
  coverage: z.array(SessionHistoryCoverageSchema).optional(),
  outbox: SessionAppendStoreStateSchema.optional(),
});

interface StoredSessionState extends SessionHistoryStoreSnapshot {
  version: typeof SESSION_STORE_VERSION;
  outbox?: z.infer<typeof SessionAppendStoreStateSchema>;
}

export function decodeSessionStoreValue(
  value: string
): StoredSessionState | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return undefined;
  }

  const parsed = StoredSessionStateSchema.safeParse(decoded);
  return parsed.success ? (parsed.data as StoredSessionState) : undefined;
}

export function encodeSessionStoreValue(input: {
  timeline?: SessionHistoryStoreSnapshot;
  outbox?: z.infer<typeof SessionAppendStoreStateSchema>;
}): string {
  if (input.timeline?.events?.length && input.timeline.coverage === undefined) {
    throw new StarciteError(
      "Stored session timeline with events must include coverage."
    );
  }

  return JSON.stringify({
    version: SESSION_STORE_VERSION,
    lastSeq: input.timeline?.lastSeq ?? 0,
    cursor: input.timeline?.cursor,
    events: input.timeline?.events,
    coverage: input.timeline?.coverage,
    outbox: input.outbox,
  } satisfies StoredSessionState);
}

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
   * Defaults to `"starcite:v2"`.
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
export interface WebStorageSessionStoreOptions extends SessionStoreOptions {}

/**
 * Default in-memory session store.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, string>();

  read(sessionId: string): string | undefined {
    return this.sessions.get(sessionId);
  }

  write(sessionId: string, value: string): void {
    this.sessions.set(sessionId, value);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * Session store backed by a Web Storage-compatible object.
 */
export class WebStorageSessionStore implements SessionStore {
  private readonly storage: StarciteWebStorage;
  private readonly keyForSession: (sessionId: string) => string;

  constructor(
    storage: StarciteWebStorage,
    options: WebStorageSessionStoreOptions = {}
  ) {
    this.storage = storage;
    const prefix = options.keyPrefix ?? "starcite:v2";
    this.keyForSession =
      options.keyForSession ??
      ((sessionId) => `${prefix}:${sessionId}:sessionStore`);
  }

  read(sessionId: string): string | undefined {
    return this.storage.getItem(this.keyForSession(sessionId)) ?? undefined;
  }

  write(sessionId: string, value: string): void {
    this.storage.setItem(this.keyForSession(sessionId), value);
  }

  clear(sessionId: string): void {
    this.storage.removeItem?.(this.keyForSession(sessionId));
  }
}

/**
 * Session store backed by browser local storage.
 */
export class LocalStorageSessionStore extends WebStorageSessionStore {
  constructor(options: WebStorageSessionStoreOptions = {}) {
    if (typeof localStorage === "undefined") {
      throw new StarciteError(
        "localStorage is not available in this runtime. Use WebStorageSessionStore with a custom storage adapter."
      );
    }
    super(localStorage, options);
  }
}

/**
 * Session store backed by browser session storage.
 */
export class SessionStorageSessionStore extends WebStorageSessionStore {
  constructor(options: WebStorageSessionStoreOptions = {}) {
    if (typeof sessionStorage === "undefined") {
      throw new StarciteError(
        "sessionStorage is not available in this runtime. Use WebStorageSessionStore with a custom storage adapter."
      );
    }
    super(sessionStorage, options);
  }
}
