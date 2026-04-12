import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
import type { SessionEventsResponse } from "./session-events";
import type {
  SessionLogCheckpoint,
  SessionSnapshot,
  TailCursor,
  TailEvent,
} from "./types";

interface SessionLogEvents {
  event: (event: TailEvent, context: SessionLogSubscriptionContext) => void;
}

type SessionLogSnapshot = Pick<
  SessionSnapshot,
  "cursor" | "events" | "lastSeq" | "syncing"
>;

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
      if (this.apply(event, { emit: true })) {
        applied.push(event);
      }
    }

    return applied;
  }

  observeRead(response: SessionEventsResponse): TailEvent[] {
    const applied: TailEvent[] = [];

    for (const event of response.events) {
      if (this.apply(event, { emit: false })) {
        applied.push(event);
      }
    }

    this.appliedSeq = Math.max(this.appliedSeq, response.last_seq);
    this.appliedCursor =
      this.appliedCursor === undefined
        ? response.next_cursor
        : Math.max(this.appliedCursor, response.next_cursor);

    return applied;
  }

  restore(checkpoint: SessionLogCheckpoint): void {
    if (!Number.isInteger(checkpoint.lastSeq) || checkpoint.lastSeq < 0) {
      throw new StarciteError(
        "Session cache checkpoint lastSeq must be a non-negative integer"
      );
    }

    this.eventBySeq.clear();
    this.appliedSeq = checkpoint.lastSeq;
    this.appliedCursor = checkpoint.cursor;
  }

  checkpoint(): SessionLogCheckpoint {
    return {
      lastSeq: this.appliedSeq,
      cursor: this.appliedCursor,
    };
  }

  subscribe(
    listener: (
      event: TailEvent,
      context: SessionLogSubscriptionContext
    ) => void,
    options: { replay?: boolean } = {}
  ): () => void {
    if (options.replay ?? false) {
      for (const event of this.orderedEvents()) {
        listener(event, { replayed: true });
      }
    }

    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  state(syncing: boolean): SessionLogSnapshot {
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

  private apply(event: TailEvent, options: { emit: boolean }): boolean {
    const previousLastSeq = this.appliedSeq;
    this.eventBySeq.set(event.seq, event);

    this.appliedSeq = Math.max(this.appliedSeq, event.seq);
    if (
      event.cursor &&
      (this.appliedCursor === undefined || event.seq >= previousLastSeq)
    ) {
      this.appliedCursor = event.cursor;
    }

    if (options.emit) {
      this.emitter.emit("event", event, { replayed: false });
    }

    return true;
  }
}
