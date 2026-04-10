import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
import type {
  SessionLogCheckpoint,
  SessionLogRange,
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

function normalizeRanges(
  ranges: readonly SessionLogRange[]
): SessionLogRange[] {
  const merged: SessionLogRange[] = [];
  const sorted = [...ranges].sort((left, right) => {
    return left.fromSeq - right.fromSeq;
  });

  for (const range of sorted) {
    if (range.fromSeq > range.toSeq) {
      throw new StarciteError(
        `Invalid session log range ${range.fromSeq}-${range.toSeq}`
      );
    }

    const previous = merged.at(-1);
    if (!previous || range.fromSeq > previous.toSeq + 1) {
      merged.push({ ...range });
      continue;
    }

    previous.toSeq = Math.max(previous.toSeq, range.toSeq);
  }

  return merged;
}

function inferRanges(events: readonly TailEvent[]): SessionLogRange[] {
  if (events.length === 0) {
    return [];
  }

  const ranges: SessionLogRange[] = [];
  let startSeq = events[0]?.seq;
  let previousSeq = events[0]?.seq;

  if (startSeq === undefined || previousSeq === undefined) {
    return ranges;
  }

  for (const event of events.slice(1)) {
    if (event.seq !== previousSeq + 1) {
      ranges.push({
        fromSeq: startSeq,
        toSeq: previousSeq,
      });
      startSeq = event.seq;
    }
    previousSeq = event.seq;
  }

  ranges.push({
    fromSeq: startSeq,
    toSeq: previousSeq,
  });
  return ranges;
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
  private loadedRanges: SessionLogRange[] = [];
  private appliedSeq = 0;
  private appliedCursor: TailCursor | undefined;
  private knownLastSeq = false;
  private fullyLoaded = false;

  private orderedEvents(): TailEvent[] {
    return [...this.eventBySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  private inferredFullyLoaded(): boolean {
    if (!this.knownLastSeq) {
      return false;
    }

    if (this.appliedSeq === 0 && this.eventBySeq.size === 0) {
      return true;
    }

    const firstRange = this.loadedRanges[0];
    return (
      this.loadedRanges.length === 1 &&
      firstRange !== undefined &&
      firstRange.fromSeq <= 1 &&
      firstRange.toSeq >= this.appliedSeq
    );
  }

  private refreshInferredCoverage(): void {
    if (!this.fullyLoaded) {
      this.fullyLoaded = this.inferredFullyLoaded();
    }
  }

  private insertRetainedEvent(event: TailEvent): void {
    this.eventBySeq.set(event.seq, event);
    this.loadedRanges = normalizeRanges([
      ...this.loadedRanges,
      { fromSeq: event.seq, toSeq: event.seq },
    ]);
    this.appliedSeq = Math.max(this.appliedSeq, event.seq);
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

  restore(checkpoint: SessionLogCheckpoint): void {
    if (!Number.isInteger(checkpoint.lastSeq) || checkpoint.lastSeq < 0) {
      throw new StarciteError(
        "Session cache checkpoint lastSeq must be a non-negative integer"
      );
    }

    let latestEvent: TailEvent | undefined;
    const nextEventsBySeq = new Map<number, TailEvent>();

    for (const event of checkpoint.events) {
      if (event.seq > checkpoint.lastSeq) {
        throw new StarciteError(
          `Session cache checkpoint contains event seq ${event.seq} above lastSeq ${checkpoint.lastSeq}`
        );
      }

      if (latestEvent === undefined || event.seq > latestEvent.seq) {
        latestEvent = event;
      }

      nextEventsBySeq.set(event.seq, event);
    }

    const orderedEvents = [...nextEventsBySeq.values()].sort((a, b) => {
      return a.seq - b.seq;
    });
    const loadedRanges = normalizeRanges(
      checkpoint.loadedRanges ?? inferRanges(orderedEvents)
    );
    for (const range of loadedRanges) {
      if (range.toSeq > checkpoint.lastSeq) {
        throw new StarciteError(
          `Session cache checkpoint range ${range.fromSeq}-${range.toSeq} exceeds lastSeq ${checkpoint.lastSeq}`
        );
      }
    }

    this.eventBySeq.clear();
    for (const [seq, event] of nextEventsBySeq) {
      this.eventBySeq.set(seq, event);
    }

    this.loadedRanges = loadedRanges;
    this.appliedSeq = checkpoint.lastSeq;
    this.appliedCursor = checkpoint.cursor ?? latestEvent?.cursor;
    this.knownLastSeq = checkpoint.lastSeqKnown ?? orderedEvents.length > 0;
    this.fullyLoaded = checkpoint.fullyLoaded ?? this.inferredFullyLoaded();
  }

  checkpoint(): SessionLogCheckpoint {
    return {
      lastSeq: this.appliedSeq,
      cursor: this.appliedCursor,
      events: this.orderedEvents(),
      lastSeqKnown: this.knownLastSeq,
      loadedRanges: this.loadedRanges.length > 0 ? [...this.loadedRanges] : [],
      fullyLoaded: this.fullyLoaded,
    };
  }

  mergeHistory(
    batch: TailEvent[],
    options: {
      fullyLoaded?: boolean;
      lastSeqKnown?: boolean;
    } = {}
  ): TailEvent[] {
    const applied: TailEvent[] = [];
    const orderedBatch = [...batch].sort((left, right) => left.seq - right.seq);

    for (const event of orderedBatch) {
      this.insertRetainedEvent(event);
      applied.push(event);
    }

    if (options.lastSeqKnown) {
      this.knownLastSeq = true;
    }

    if (options.fullyLoaded) {
      this.knownLastSeq = true;
      this.fullyLoaded = true;
      return applied;
    }

    this.refreshInferredCoverage();
    return applied;
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

  latest(count: number): TailEvent[] {
    if (count <= 0) {
      return [];
    }

    const orderedEvents = this.orderedEvents();
    return orderedEvents.slice(Math.max(0, orderedEvents.length - count));
  }

  window(fromSeq: number, toSeq: number): TailEvent[] {
    if (fromSeq > toSeq) {
      return [];
    }

    return this.orderedEvents().filter((event) => {
      return event.seq >= fromSeq && event.seq <= toSeq;
    });
  }

  missingRanges(fromSeq: number, toSeq: number): SessionLogRange[] {
    if (fromSeq > toSeq) {
      return [];
    }

    const boundedToSeq =
      this.knownLastSeq && toSeq > this.appliedSeq ? this.appliedSeq : toSeq;
    if (fromSeq > boundedToSeq) {
      return [];
    }

    if (this.fullyLoaded) {
      return [];
    }

    const missing: SessionLogRange[] = [];
    let nextFromSeq = fromSeq;

    for (const range of this.loadedRanges) {
      if (range.toSeq < nextFromSeq) {
        continue;
      }
      if (range.fromSeq > boundedToSeq) {
        break;
      }
      if (range.fromSeq > nextFromSeq) {
        missing.push({
          fromSeq: nextFromSeq,
          toSeq: Math.min(boundedToSeq, range.fromSeq - 1),
        });
      }
      nextFromSeq = Math.max(nextFromSeq, range.toSeq + 1);
      if (nextFromSeq > boundedToSeq) {
        break;
      }
    }

    if (nextFromSeq <= boundedToSeq) {
      missing.push({
        fromSeq: nextFromSeq,
        toSeq: boundedToSeq,
      });
    }

    return missing;
  }

  canServeLast(count: number): boolean {
    if (count <= 0) {
      return true;
    }

    if (!this.knownLastSeq) {
      return false;
    }

    if (this.appliedSeq === 0 && this.eventBySeq.size === 0) {
      return true;
    }

    const fromSeq = Math.max(0, this.appliedSeq - count + 1);
    return this.missingRanges(fromSeq, this.appliedSeq).length === 0;
  }

  get cursor(): TailCursor | undefined {
    return this.appliedCursor;
  }

  get lastSeq(): number {
    return this.appliedSeq;
  }

  get hasKnownLastSeq(): boolean {
    return this.knownLastSeq;
  }

  get isFullyLoaded(): boolean {
    return this.fullyLoaded;
  }

  markFullyLoaded(): void {
    this.knownLastSeq = true;
    this.fullyLoaded = true;
  }

  markSparse(): void {
    this.fullyLoaded = false;
    this.knownLastSeq = false;
  }

  advanceCursor(cursor: TailCursor): void {
    this.appliedCursor = cursor;
  }

  private apply(event: TailEvent): boolean {
    const previousLastSeq = this.appliedSeq;
    this.insertRetainedEvent(event);
    this.knownLastSeq = true;

    if (
      event.cursor &&
      (this.appliedCursor === undefined || event.seq >= previousLastSeq)
    ) {
      this.appliedCursor = event.cursor;
    }

    if (this.fullyLoaded && event.seq > previousLastSeq + 1) {
      this.fullyLoaded = false;
    }
    this.refreshInferredCoverage();
    return true;
  }
}
