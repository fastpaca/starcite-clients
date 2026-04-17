const DEFAULT_NEW_SESSION_CURSOR_GRACE_MS = 30_000;
const NEW_SESSION_REPLAY_CURSOR = 0;

/**
 * Tracks just-created session ids for a short grace window so the first tail
 * attach can replay from cursor zero and avoid missing the opening event.
 */
export class NewSessionCursorRegistry {
  private readonly expiresAtBySessionId = new Map<string, number>();
  private readonly graceMs: number;

  constructor(graceMs = DEFAULT_NEW_SESSION_CURSOR_GRACE_MS) {
    this.graceMs = graceMs;
  }

  remember(sessionId: string): void {
    const now = Date.now();
    this.pruneExpired(now);
    this.expiresAtBySessionId.set(sessionId, now + this.graceMs);
  }

  initialCursorFor(sessionId: string): 0 | undefined {
    this.pruneExpired(Date.now());
    const expiresAt = this.expiresAtBySessionId.get(sessionId);
    if (expiresAt === undefined) {
      return undefined;
    }

    return NEW_SESSION_REPLAY_CURSOR;
  }

  private pruneExpired(now: number): void {
    for (const [sessionId, expiresAt] of this.expiresAtBySessionId) {
      if (expiresAt <= now) {
        this.expiresAtBySessionId.delete(sessionId);
      }
    }
  }
}
