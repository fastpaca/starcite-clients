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
 * Maintains a seq-indexed ordered history of committed events.
 * Same seq = always overwrite (server is source of truth).
 * New seq = insert in sorted order.
 */
export class SessionLog {
  private readonly history: TailEvent[] = [];
  private readonly emitter = new EventEmitter<SessionLogEvents>();
  private readonly eventBySeq = new Map<number, TailEvent>();
  private appliedSeq = 0;
  private appliedCursor: TailCursor | undefined;

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

    const sorted = [...state.events]
      .filter((event) => {
        if (event.seq > state.lastSeq) {
          throw new StarciteError(
            `Session store contains event seq ${event.seq} above lastSeq ${state.lastSeq}`
          );
        }
        return true;
      })
      .sort((a, b) => a.seq - b.seq);

    const latestEvent = sorted.at(-1);

    this.history.length = 0;
    this.history.push(...sorted);
    this.eventBySeq.clear();
    for (const event of sorted) {
      this.eventBySeq.set(event.seq, event);
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
      for (const event of this.history) {
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
      events: this.history.slice(),
      lastSeq: this.appliedSeq,
      cursor: this.appliedCursor,
      syncing,
    };
  }

  get events(): readonly TailEvent[] {
    return this.history;
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

    if (this.eventBySeq.has(event.seq)) {
      // Same seq — overwrite in place (server is source of truth)
      const existingIndex = this.history.findIndex((e) => e.seq === event.seq);
      if (existingIndex >= 0) {
        this.history[existingIndex] = event;
        this.eventBySeq.set(event.seq, event);
      }
    } else {
      // New seq — insert in sorted order (fast path: append)
      const lastSeq = this.history.at(-1)?.seq;
      if (lastSeq === undefined || event.seq > lastSeq) {
        this.history.push(event);
      } else {
        const insertAt = this.history.findIndex((e) => e.seq > event.seq);
        if (insertAt === -1) {
          this.history.push(event);
        } else {
          this.history.splice(insertAt, 0, event);
        }
      }

      this.eventBySeq.set(event.seq, event);
    }

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
