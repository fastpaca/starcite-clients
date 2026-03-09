import {
  type SessionStore,
  type SessionStoreState,
  type TailEvent,
  WebStorageSessionStore,
} from "@starcite/sdk";
import Conf from "conf";

const STATE_FILENAME = "state";
const TRAILING_SLASHES_REGEX = /\/+$/;
const STORE_VERSION_KEY = "__starciteCliStoreVersion";
const CURRENT_STORE_VERSION = "2";

export function buildSessionStoreContextKey(
  baseUrl: string,
  sessionId: string
): string {
  return `${baseUrl}::${sessionId}`;
}

function normalizeStoreBaseUrl(baseUrl: string): string {
  if (baseUrl.length === 0) {
    return "";
  }

  const normalized = baseUrl.replace(TRAILING_SLASHES_REGEX, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export class StarciteCliStore implements SessionStore<TailEvent> {
  private readonly storage: Conf<Record<string, string>>;

  constructor(directory: string) {
    this.storage = new Conf<Record<string, string>>({
      cwd: directory,
      clearInvalidConfig: true,
      configName: STATE_FILENAME,
      fileExtension: "json",
      defaults: {},
    });

    this.resetOnStoreVersionMismatch();
  }

  sessionStore(baseUrl: string): SessionStore<TailEvent> {
    return new WebStorageSessionStore<TailEvent>(this.storageAdapter(), {
      keyForSession: (sessionId) =>
        buildSessionStoreContextKey(normalizeStoreBaseUrl(baseUrl), sessionId),
    });
  }

  load(sessionId: string): SessionStoreState<TailEvent> | undefined {
    return this.sessionStore("").load(sessionId);
  }

  save(sessionId: string, state: SessionStoreState<TailEvent>): void {
    this.sessionStore("").save(sessionId, state);
  }

  clear(sessionId: string): void {
    this.sessionStore("").clear?.(sessionId);
  }

  clearSession(baseUrl: string, sessionId: string): void {
    this.sessionStore(baseUrl).clear?.(sessionId);
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

  private resetOnStoreVersionMismatch(): void {
    const storedVersion = this.storage.get(STORE_VERSION_KEY);
    if (storedVersion === CURRENT_STORE_VERSION) {
      return;
    }

    this.storage.clear();
    this.storage.set(STORE_VERSION_KEY, CURRENT_STORE_VERSION);
  }
}
