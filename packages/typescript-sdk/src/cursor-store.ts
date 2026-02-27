import { StarciteError } from "./errors";
import type { SessionCursorStore } from "./types";

const DEFAULT_CURSOR_KEY_PREFIX = "starcite";

/**
 * Minimal Web Storage contract used by cursor-store helpers.
 */
export interface StarciteWebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Cursor-store key customization options.
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

function keyForSessionResolver(
  options: CursorStoreOptions
): (sessionId: string) => string {
  if (options.keyForSession) {
    return options.keyForSession;
  }

  const keyPrefix = options.keyPrefix?.trim() || DEFAULT_CURSOR_KEY_PREFIX;

  return (sessionId: string) => `${keyPrefix}:${sessionId}:lastSeq`;
}

function parseStoredCursor(raw: string): number | undefined {
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

/**
 * Creates an in-memory cursor store (useful for workers/tests).
 */
export function createInMemoryCursorStore(
  initial: Record<string, number> = {}
): SessionCursorStore {
  const cursors = new Map<string, number>();

  for (const [sessionId, cursor] of Object.entries(initial)) {
    cursors.set(sessionId, cursor);
  }

  return {
    load(sessionId: string): number | undefined {
      return cursors.get(sessionId);
    },
    save(sessionId: string, cursor: number): void {
      cursors.set(sessionId, cursor);
    },
  };
}

/**
 * Creates a cursor store backed by a Web Storage-compatible object.
 */
export function createWebStorageCursorStore(
  storage: StarciteWebStorage,
  options: CursorStoreOptions = {}
): SessionCursorStore {
  const keyForSession = keyForSessionResolver(options);

  return {
    load(sessionId: string): number | undefined {
      const key = keyForSession(sessionId);
      const raw = storage.getItem(key);

      if (raw === null) {
        return undefined;
      }

      return parseStoredCursor(raw);
    },
    save(sessionId: string, cursor: number): void {
      const key = keyForSession(sessionId);
      storage.setItem(key, `${cursor}`);
    },
  };
}

/**
 * Creates a cursor store backed by `globalThis.localStorage`.
 */
export function createLocalStorageCursorStore(
  options: CursorStoreOptions = {}
): SessionCursorStore {
  if (typeof localStorage === "undefined") {
    throw new StarciteError(
      "localStorage is not available in this runtime. Use createWebStorageCursorStore(...) with a custom storage adapter."
    );
  }

  return createWebStorageCursorStore(localStorage, options);
}
