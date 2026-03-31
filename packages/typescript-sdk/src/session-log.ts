import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
import type {
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
 * Maintains deduplicated events by sequence and exposes them in sequence order.
 * Same seq = always overwrite (server is source of truth).
 */
export class SessionLog {
  private readonly emitter = new EventEmitter<SessionLogEvents>();
  private readonly eventBySeq = new Map<number, TailEvent>();
  private appliedSeq = 0;
  private appliedCursor: TailCursor | undefined;

  private orderedEvents(): TailEvent[] {
    return [...this.eventBySeq.values()].sort((a, b) => a.seq - b.seq);
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

    let latestEvent: TailEvent | undefined;
    const nextEventsBySeq = new Map<number, TailEvent>();

    for (const event of state.events) {
      if (event.seq > state.lastSeq) {
        throw new StarciteError(
          `Session store contains event seq ${event.seq} above lastSeq ${state.lastSeq}`
        );
      }

      if (latestEvent === undefined || event.seq > latestEvent.seq) {
        latestEvent = event;
      }

      nextEventsBySeq.set(event.seq, event);
    }

    this.eventBySeq.clear();
    for (const [seq, event] of nextEventsBySeq) {
      this.eventBySeq.set(seq, event);
    }

    this.appliedSeq = state.lastSeq;
    this.appliedCursor = state.cursor ?? latestEvent?.cursor;
  }

  subscribe(
    listener: (
      event: TailEvent,
      context: SessionLogSubscriptionContext
    ) => void,
    options: { replay?: boolean } = {}
  ): () => void {
    if (options.replay ?? true) {
      for (const event of this.orderedEvents()) {
        listener(event, { replayed: true });
      }
    }

    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  state(syncing: boolean): SessionSnapshot {
    return {
      events: this.orderedEvents(),
      lastSeq: this.appliedSeq,
      cursor: this.appliedCursor,
      syncing,
    };
  }

  get events(): readonly TailEvent[] {
    return this.orderedEvents();
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

  private apply(event: TailEvent): boolean {
    const previousLastSeq = this.appliedSeq;
    this.eventBySeq.set(event.seq, event);

    this.appliedSeq = Math.max(this.appliedSeq, event.seq);
    if (
      event.cursor &&
      (this.appliedCursor === undefined || event.seq >= previousLastSeq)
    ) {
      this.appliedCursor = event.cursor;
    }
    return true;
  }
}
