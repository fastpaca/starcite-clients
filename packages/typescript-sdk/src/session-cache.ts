import { z } from "zod";
import { StarciteError } from "./errors";
import {
  SessionAppendStoreStateSchema,
  type SessionCache,
  type SessionCacheEntry,
  TailCursorSchema,
} from "./types";

const SessionLogCheckpointSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
  cursor: TailCursorSchema.optional(),
});

const SessionCacheMetadataSchema = z.object({
  schemaVersion: z.union([z.literal(5), z.literal(6)]),
  cachedAtMs: z.number().int().nonnegative(),
});

const SessionCacheEntrySchema = z.object({
  log: SessionLogCheckpointSchema.optional(),
  outbox: SessionAppendStoreStateSchema.optional(),
  metadata: SessionCacheMetadataSchema.optional(),
});

export interface StarciteWebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * Key customization options for storage-backed session caches.
 */
export interface SessionCacheOptions {
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
 * Construction options for {@link WebStorageSessionCache}.
 */
export interface WebStorageSessionCacheOptions extends SessionCacheOptions {
  /**
   * Optional schema for validating persisted cache entries.
   *
   * When omitted, a default schema validates canonical cache entries.
   */
  entrySchema?: z.ZodType<SessionCacheEntry>;
}

/**
 * Default in-memory session cache.
 */
export class MemorySessionCache implements SessionCache {
  private readonly sessions = new Map<string, SessionCacheEntry>();

  read(sessionId: string): SessionCacheEntry | undefined {
    return this.sessions.get(sessionId);
  }

  write(sessionId: string, entry: SessionCacheEntry): void {
    this.sessions.set(sessionId, entry);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * Session cache backed by a Web Storage-compatible object.
 */
export class WebStorageSessionCache implements SessionCache {
  private readonly storage: StarciteWebStorage;
  private readonly keyForSession: (sessionId: string) => string;
  private readonly entrySchema: z.ZodType<SessionCacheEntry>;

  constructor(
    storage: StarciteWebStorage,
    options: WebStorageSessionCacheOptions = {}
  ) {
    this.storage = storage;
    const prefix = options.keyPrefix ?? "starcite";
    this.keyForSession =
      options.keyForSession ??
      ((sessionId) => `${prefix}:${sessionId}:sessionCache`);
    this.entrySchema =
      options.entrySchema ??
      (SessionCacheEntrySchema as unknown as z.ZodType<SessionCacheEntry>);
  }

  read(sessionId: string): SessionCacheEntry | undefined {
    const raw = this.storage.getItem(this.keyForSession(sessionId));
    if (raw === null) {
      return undefined;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.clear(sessionId);
      return undefined;
    }

    const parsed = this.entrySchema.safeParse(decoded);
    if (!parsed.success) {
      this.clear(sessionId);
      return undefined;
    }

    return parsed.data;
  }

  write(sessionId: string, entry: SessionCacheEntry): void {
    this.storage.setItem(this.keyForSession(sessionId), JSON.stringify(entry));
  }

  clear(sessionId: string): void {
    this.storage.removeItem?.(this.keyForSession(sessionId));
  }
}

/**
 * Session cache backed by browser local storage.
 */
export class LocalStorageSessionCache extends WebStorageSessionCache {
  constructor(options: WebStorageSessionCacheOptions = {}) {
    if (typeof localStorage === "undefined") {
      throw new StarciteError(
        "localStorage is not available in this runtime. Use WebStorageSessionCache with a custom storage adapter."
      );
    }
    super(localStorage, options);
  }
}

/**
 * Session cache backed by browser session storage.
 */
export class SessionStorageSessionCache extends WebStorageSessionCache {
  constructor(options: WebStorageSessionCacheOptions = {}) {
    if (typeof sessionStorage === "undefined") {
      throw new StarciteError(
        "sessionStorage is not available in this runtime. Use WebStorageSessionCache with a custom storage adapter."
      );
    }
    super(sessionStorage, options);
  }
}
