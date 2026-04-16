const DEFAULT_NEW_SESSION_CURSOR_GRACE_MS = 30_000;

/**
 * Tracks just-created session ids for a short grace window so the first tail
 * attach can replay from cursor zero and avoid missing the opening event.
 */
export class NewSessionCursorRegistry {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly graceMs: number;

  constructor(graceMs = DEFAULT_NEW_SESSION_CURSOR_GRACE_MS) {
    this.graceMs = graceMs;
  }

  remember(sessionId: string): void {
    const previousTimer = this.timers.get(sessionId);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    const cleanup = setTimeout(() => {
      this.timers.delete(sessionId);
    }, this.graceMs);
    cleanup.unref?.();
    this.timers.set(sessionId, cleanup);
  }

  initialCursorFor(sessionId: string): 0 | undefined {
    return this.timers.has(sessionId) ? 0 : undefined;
  }
}
