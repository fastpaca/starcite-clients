import type { SessionStore, SessionStoreState, TailEvent } from "./types";

function cloneEvents(events: readonly TailEvent[]): TailEvent[] {
  // Store boundaries should not share mutable arrays across callers.
  return events.map((event) => structuredClone(event));
}

function cloneState(state: SessionStoreState): SessionStoreState {
  return {
    cursor: state.cursor,
    events: cloneEvents(state.events),
  };
}

/**
 * Default in-memory session store.
 *
 * Persists both cursor and retained events for each session so late subscribers
 * can replay immediately after process-local reconnect/rebind.
 */
export class MemoryStore implements SessionStore {
  private readonly sessions = new Map<string, SessionStoreState>();

  load(sessionId: string): SessionStoreState | undefined {
    const stored = this.sessions.get(sessionId);
    return stored ? cloneState(stored) : undefined;
  }

  save(sessionId: string, state: SessionStoreState): void {
    this.sessions.set(sessionId, cloneState(state));
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
