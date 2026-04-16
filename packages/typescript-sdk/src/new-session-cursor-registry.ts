const DEFAULT_NEW_SESSION_CURSOR_GRACE_MS = 30_000;

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
    this.expiresAtBySessionId.set(sessionId, Date.now() + this.graceMs);
  }

  initialCursorFor(sessionId: string): 0 | undefined {
    const expiresAt = this.expiresAtBySessionId.get(sessionId);
    if (expiresAt === undefined) {
      return undefined;
    }

    if (expiresAt <= Date.now()) {
      this.expiresAtBySessionId.delete(sessionId);
      return undefined;
    }

    return 0;
  }
}
