import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
import type {
  SessionLogOptions,
  SessionSnapshot,
  SessionStoreState,
  TailCursor,
  TailEvent,
} from "./types";

interface SessionLogEvents {
  event: (event: TailEvent, context: SessionLogSubscriptionContext) => void;
}

export interface SessionLogSubscriptionContext {
  replayed: boolean;
}

/**
 * Canonical in-memory log for one session.
 *
 * Invariants:
 * - Maintains a best-effort committed mirror keyed by `seq`.
 * - Treats repeated identical events as idempotent no-ops.
 * - Accepts out-of-order or corrected server events and overwrites local state.
 */
export class SessionLog {
  private readonly history: TailEvent[] = [];
  private readonly emitter = new EventEmitter<SessionLogEvents>();
  private readonly canonicalBySeq = new Map<number, string>();
  private maxEvents: number | undefined;
  private appliedSeq = 0;
  private appliedCursor: TailCursor | undefined;

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
        this.emitter.emit("event", event, { replayed: false });
      }
    }

    return applied;
  }

  hydrate(state: SessionStoreState): void {
    if (!Number.isInteger(state.lastSeq) || state.lastSeq < 0) {
      throw new StarciteError(
        "Session store lastSeq must be a non-negative integer"
      );
    }

    const nextBySeq = new Map<number, TailEvent>();
    const nextCanonicalBySeq = new Map<number, string>();
    for (const event of state.events) {
      if (event.seq > state.lastSeq) {
        throw new StarciteError(
          `Session store contains event seq ${event.seq} above lastSeq ${state.lastSeq}`
        );
      }

      nextBySeq.set(event.seq, event);
      nextCanonicalBySeq.set(event.seq, JSON.stringify(event));
    }

    const nextHistory = [...nextBySeq.values()].sort((left, right) => {
      return left.seq - right.seq;
    });
    const latestEvent = nextHistory.at(-1);

    this.history.length = 0;
    this.history.push(...nextHistory);
    this.canonicalBySeq.clear();
    for (const [seq, canonical] of nextCanonicalBySeq.entries()) {
      this.canonicalBySeq.set(seq, canonical);
    }
    this.appliedSeq = state.lastSeq;
    if (state.cursor) {
      this.appliedCursor = state.cursor;
    } else if (latestEvent?.cursor) {
      this.appliedCursor = latestEvent.cursor;
    } else {
      this.appliedCursor = undefined;
    }
    this.enforceRetention();
  }

  subscribe(
    listener: (
      event: TailEvent,
      context: SessionLogSubscriptionContext
    ) => void,
    options: { replay?: boolean } = {}
  ): () => void {
    const shouldReplay = options.replay ?? true;
    if (shouldReplay) {
      for (const event of this.history) {
        listener(event, { replayed: true });
      }
    }

    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  private apply(event: TailEvent): boolean {
    const previousLastSeq = this.appliedSeq;
    const incomingCanonical = JSON.stringify(event);
    const existingCanonical = this.canonicalBySeq.get(event.seq);

    if (existingCanonical === incomingCanonical) {
      return false;
    }

    const oldestRetainedSeq = this.history[0]?.seq;
    if (
      existingCanonical === undefined &&
      oldestRetainedSeq !== undefined &&
      event.seq < oldestRetainedSeq
    ) {
      return false;
    }

    const existingIndex = this.history.findIndex((entry) => {
      return entry.seq === event.seq;
    });
    if (existingIndex >= 0) {
      this.history[existingIndex] = event;
    } else {
      const insertIndex = this.history.findIndex((entry) => {
        return entry.seq > event.seq;
      });
      if (insertIndex === -1) {
        this.history.push(event);
      } else {
        this.history.splice(insertIndex, 0, event);
      }
    }

    this.canonicalBySeq.set(event.seq, incomingCanonical);
    this.appliedSeq = Math.max(this.appliedSeq, event.seq);
    if (
      event.cursor &&
      (this.appliedCursor === undefined || event.seq >= previousLastSeq)
    ) {
      this.appliedCursor = event.cursor;
    }
    this.enforceRetention();
    return true;
  }

  state(syncing: boolean): SessionSnapshot {
    return {
      events: this.history.slice(),
      lastSeq: this.appliedSeq,
      cursor: this.appliedCursor,
      syncing,
    };
  }

  get events(): readonly TailEvent[] {
    return this.history.slice();
  }

  get cursor(): TailCursor | undefined {
    return this.appliedCursor;
  }

  get lastSeq(): number {
    return this.appliedSeq;
  }

  advanceCursor(cursor: TailCursor): void {
    this.appliedCursor = cursor;
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
