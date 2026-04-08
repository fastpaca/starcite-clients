import {
  type SessionCache,
  type SessionCacheEntry,
  type TailEvent,
  WebStorageSessionCache,
} from "@starcite/sdk";
import Conf from "conf";

const STATE_FILENAME = "state";
const TRAILING_SLASHES_REGEX = /\/+$/;
const CACHE_VERSION_KEY = "__starciteCliCacheVersion";
const LEGACY_STORE_VERSION_KEY = "__starciteCliStoreVersion";
const CURRENT_CACHE_VERSION = "3";

export function buildSessionCacheContextKey(
  baseUrl: string,
  sessionId: string
): string {
  return `${baseUrl}::${sessionId}`;
}

function normalizeCacheBaseUrl(baseUrl: string): string {
  if (baseUrl.length === 0) {
    return "";
  }

  const normalized = baseUrl.replace(TRAILING_SLASHES_REGEX, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export class StarciteCliCache implements SessionCache<TailEvent> {
  private readonly storage: Conf<Record<string, string>>;

  constructor(directory: string) {
    this.storage = new Conf<Record<string, string>>({
      cwd: directory,
      clearInvalidConfig: true,
      configName: STATE_FILENAME,
      fileExtension: "json",
      defaults: {},
    });

    this.resetOnCacheVersionMismatch();
  }

  sessionCache(baseUrl: string): SessionCache<TailEvent> {
    return new WebStorageSessionCache<TailEvent>(this.storageAdapter(), {
      keyForSession: (sessionId) =>
        buildSessionCacheContextKey(normalizeCacheBaseUrl(baseUrl), sessionId),
    });
  }

  read(sessionId: string): SessionCacheEntry<TailEvent> | undefined {
    return this.sessionCache("").read(sessionId);
  }

  write(sessionId: string, entry: SessionCacheEntry<TailEvent>): void {
    this.sessionCache("").write(sessionId, entry);
  }

  clear(sessionId: string): void {
    this.sessionCache("").clear?.(sessionId);
  }

  clearSession(baseUrl: string, sessionId: string): void {
    this.sessionCache(baseUrl).clear?.(sessionId);
  }

  private storageAdapter() {
    return {
      getItem: (key: string): string | null => this.storage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        this.storage.set(key, value);
      },
      removeItem: (key: string): void => {
        this.storage.delete(key);
      },
    };
  }

  private resetOnCacheVersionMismatch(): void {
    const storedVersion =
      this.storage.get(CACHE_VERSION_KEY) ??
      this.storage.get(LEGACY_STORE_VERSION_KEY);
    if (storedVersion === CURRENT_CACHE_VERSION) {
      return;
    }

    this.storage.clear();
    this.storage.set(CACHE_VERSION_KEY, CURRENT_CACHE_VERSION);
  }
}
