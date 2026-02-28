import { StarciteError } from "./errors";
import type { SessionCursorStore } from "./types";

const DEFAULT_KEY_PREFIX = "starcite";

/**
 * Minimal Web Storage contract used by {@link WebStorageCursorStore}.
 */
export interface StarciteWebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Key customization options for storage-backed cursor stores.
 */
export interface CursorStoreOptions {
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
 * In-memory cursor store (useful for workers/tests).
 */
export class InMemoryCursorStore implements SessionCursorStore {
  private readonly cursors: Map<string, number>;

  constructor(initial: Record<string, number> = {}) {
    this.cursors = new Map(Object.entries(initial));
  }

  load(sessionId: string): number | undefined {
    return this.cursors.get(sessionId);
  }

  save(sessionId: string, cursor: number): void {
    this.cursors.set(sessionId, cursor);
  }
}

/**
 * Cursor store backed by a Web Storage-compatible object.
 */
export class WebStorageCursorStore implements SessionCursorStore {
  private readonly storage: StarciteWebStorage;
  private readonly keyForSession: (sessionId: string) => string;

  constructor(storage: StarciteWebStorage, options: CursorStoreOptions = {}) {
    this.storage = storage;
    const prefix = options.keyPrefix?.trim() || DEFAULT_KEY_PREFIX;
    this.keyForSession =
      options.keyForSession ??
      ((sessionId) => `${prefix}:${sessionId}:lastSeq`);
  }

  load(sessionId: string): number | undefined {
    const raw = this.storage.getItem(this.keyForSession(sessionId));
    if (raw === null) {
      return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }

  save(sessionId: string, cursor: number): void {
    this.storage.setItem(this.keyForSession(sessionId), `${cursor}`);
  }
}

/**
 * Cursor store backed by `globalThis.localStorage`.
 */
export class LocalStorageCursorStore extends WebStorageCursorStore {
  constructor(options: CursorStoreOptions = {}) {
    if (typeof localStorage === "undefined") {
      throw new StarciteError(
        "localStorage is not available in this runtime. Use WebStorageCursorStore with a custom storage adapter."
      );
    }
    super(localStorage, options);
  }
}
