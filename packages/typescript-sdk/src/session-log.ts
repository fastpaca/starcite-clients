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
 * Maintains a seq-indexed ordered history of committed events.
 * Duplicate deliveries at the same seq are idempotent no-ops.
 * Server corrections at an existing seq overwrite and re-emit.
 */
export class SessionLog {
  private readonly history: TailEvent[] = [];
  private readonly emitter = new EventEmitter<SessionLogEvents>();
  private readonly seenSeqs = new Set<number>();
  private readonly eventBySeq = new Map<number, TailEvent>();
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

    // Deduplicate and validate in one pass
    const bySeq = new Map<number, TailEvent>();
    for (const event of state.events) {
      if (event.seq > state.lastSeq) {
        throw new StarciteError(
          `Session store contains event seq ${event.seq} above lastSeq ${state.lastSeq}`
        );
      }
      bySeq.set(event.seq, event);
    }

    const sorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    const latestEvent = sorted.at(-1);

    this.history.length = 0;
    this.history.push(...sorted);
    this.seenSeqs.clear();
    this.eventBySeq.clear();
    for (const event of sorted) {
      this.seenSeqs.add(event.seq);
      this.eventBySeq.set(event.seq, event);
    }

    this.appliedSeq = state.lastSeq;
    this.appliedCursor = state.cursor ?? latestEvent?.cursor;
    this.enforceRetention();
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

  private apply(event: TailEvent): boolean {
    const previousLastSeq = this.appliedSeq;

    // Fast path: we've seen this seq before
    if (this.seenSeqs.has(event.seq)) {
      const existing = this.eventBySeq.get(event.seq);

      // Identical event redelivery — skip
      if (existing && this.eventsEqual(existing, event)) {
        return false;
      }

      // Server correction at same seq — overwrite
      const existingIndex = this.history.findIndex((e) => e.seq === event.seq);
      if (existingIndex >= 0) {
        this.history[existingIndex] = event;
        this.eventBySeq.set(event.seq, event);
      }
    } else {
      // Older than retained window — ignore
      const oldestSeq = this.history[0]?.seq;
      if (oldestSeq !== undefined && event.seq < oldestSeq) {
        return false;
      }

      // Insert in sorted order (fast path: append)
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

      this.seenSeqs.add(event.seq);
      this.eventBySeq.set(event.seq, event);
    }

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

  /**
   * Compares two events by their identifying/content fields.
   * Avoids JSON.stringify — uses direct field comparison.
   */
  private eventsEqual(a: TailEvent, b: TailEvent): boolean {
    return (
      a.seq === b.seq &&
      a.type === b.type &&
      a.actor === b.actor &&
      a.producer_id === b.producer_id &&
      a.producer_seq === b.producer_seq &&
      a.source === b.source &&
      a.idempotency_key === b.idempotency_key &&
      a.inserted_at === b.inserted_at &&
      a.cursor === b.cursor &&
      shallowEqual(a.payload, b.payload) &&
      shallowEqual(a.metadata, b.metadata) &&
      shallowEqual(a.refs, b.refs)
    );
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

      this.seenSeqs.delete(removed.seq);
      this.eventBySeq.delete(removed.seq);
    }
  }
}

/**
 * Shallow equality for plain objects (one level deep).
 * Handles undefined/null symmetrically.
 */
function shallowEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): boolean {
  if (a === b) {
    return true;
  }

  if (!(a && b)) {
    return false;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (a[key] !== b[key]) {
      return false;
    }
  }

  return true;
}
