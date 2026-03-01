import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
import type {
  SessionLogOptions,
  SessionSnapshot,
  SessionStoreState,
  TailEvent,
} from "./types";

interface SessionLogEvents {
  event: (event: TailEvent) => void;
}

export class SessionLogGapError extends StarciteError {
  constructor(message: string) {
    super(message);
    this.name = "SessionLogGapError";
  }
}

export class SessionLogConflictError extends StarciteError {
  constructor(message: string) {
    super(message);
    this.name = "SessionLogConflictError";
  }
}

/**
 * Canonical in-memory log for one session.
 *
 * Invariants:
 * - Applies events in strict contiguous `seq` order.
 * - Treats repeated identical events as idempotent no-ops.
 * - Rejects conflicting duplicates and sequence gaps.
 */
export class SessionLog {
  private readonly history: TailEvent[] = [];
  private readonly emitter = new EventEmitter<SessionLogEvents>();
  private readonly canonicalBySeq = new Map<number, string>();
  private maxEvents: number | undefined;
  private appliedSeq = 0;

  constructor(options: SessionLogOptions = {}) {
    this.setMaxEvents(options.maxEvents);
  }

  setMaxEvents(maxEvents: number | undefined): void {
    if (
      maxEvents !== undefined &&
      (!Number.isInteger(maxEvents) || maxEvents <= 0)
    ) {
      throw new StarciteError(
        "Session log maxEvents must be a positive integer"
      );
    }

    this.maxEvents = maxEvents;
    this.enforceRetention();
  }

  applyBatch(batch: TailEvent[]): TailEvent[] {
    const applied: TailEvent[] = [];

    for (const event of batch) {
      if (this.apply(event)) {
        applied.push(event);
        this.emitter.emit("event", event);
      }
    }

    return applied;
  }

  hydrate(state: SessionStoreState): void {
    if (!Number.isInteger(state.cursor) || state.cursor < 0) {
      throw new StarciteError(
        "Session store cursor must be a non-negative integer"
      );
    }

    this.history.length = 0;
    this.canonicalBySeq.clear();
    this.appliedSeq = state.cursor;

    let previousSeq: number | undefined;
    for (const event of state.events) {
      if (event.seq > state.cursor) {
        throw new StarciteError(
          `Session store contains event seq ${event.seq} above cursor ${state.cursor}`
        );
      }

      if (previousSeq !== undefined && event.seq !== previousSeq + 1) {
        throw new StarciteError(
          `Session store events must be contiguous; saw seq ${event.seq} after ${previousSeq}`
        );
      }

      this.history.push(event);
      this.canonicalBySeq.set(event.seq, JSON.stringify(event));
      previousSeq = event.seq;
    }

    this.enforceRetention();
  }

  subscribe(
    listener: (event: TailEvent) => void,
    options: { replay?: boolean } = {}
  ): () => void {
    const shouldReplay = options.replay ?? true;
    if (shouldReplay) {
      for (const event of this.history) {
        listener(event);
      }
    }

    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  private apply(event: TailEvent): boolean {
    const existingCanonical = this.canonicalBySeq.get(event.seq);

    if (event.seq <= this.appliedSeq) {
      const incomingCanonical = JSON.stringify(event);
      if (!existingCanonical) {
        const oldestRetainedSeq = this.history[0]?.seq;
        if (oldestRetainedSeq === undefined || event.seq < oldestRetainedSeq) {
          return false;
        }

        throw new SessionLogConflictError(
          `Session log has no canonical payload for retained seq ${event.seq}`
        );
      }

      if (incomingCanonical !== existingCanonical) {
        throw new SessionLogConflictError(
          `Session log conflict for seq ${event.seq}: received different payload for an already-applied event`
        );
      }

      return false;
    }

    const expectedSeq = this.appliedSeq + 1;
    if (event.seq !== expectedSeq) {
      throw new SessionLogGapError(
        `Session log gap detected: expected seq ${expectedSeq} but received ${event.seq}`
      );
    }

    this.history.push(event);
    this.canonicalBySeq.set(event.seq, JSON.stringify(event));
    this.appliedSeq = event.seq;
    this.enforceRetention();
    return true;
  }

  getSnapshot(syncing: boolean): SessionSnapshot {
    return {
      events: this.history.slice(),
      lastSeq: this.appliedSeq,
      syncing,
    };
  }

  get events(): readonly TailEvent[] {
    return this.history.slice();
  }

  get cursor(): number {
    return this.appliedSeq;
  }

  get lastSeq(): number {
    return this.appliedSeq;
  }

  private enforceRetention(): void {
    if (this.maxEvents === undefined) {
      return;
    }

    while (this.history.length > this.maxEvents) {
      const removed = this.history.shift();
      if (!removed) {
        return;
      }

      this.canonicalBySeq.delete(removed.seq);
    }
  }
}
