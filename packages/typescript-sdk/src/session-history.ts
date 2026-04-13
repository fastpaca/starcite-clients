import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
import type { SessionSnapshot, TailCursor, TailEvent } from "./types";

interface SessionHistoryEvents {
  event: (event: TailEvent, context: SessionHistorySubscriptionContext) => void;
}

type SessionHistorySnapshot = Pick<
  SessionSnapshot,
  "cursor" | "events" | "lastSeq" | "syncing"
>;

export interface SessionHistorySubscriptionContext {
  replayed: boolean;
}

interface SessionHistoryRange {
  fromSeq: number;
  toSeq: number;
  beforeCursor?: TailCursor;
  afterCursor?: TailCursor;
}

export interface SessionHistoryCoverage {
  fromSeq: number;
  toSeq: number;
  beforeCursor?: TailCursor;
  afterCursor?: TailCursor;
}

export interface SessionHistoryStoreSnapshot {
  lastSeq: number;
  cursor?: TailCursor;
  events?: readonly TailEvent[];
  coverage?: readonly SessionHistoryCoverage[];
}

function assertValidRange(fromSeq: number, toSeq: number): void {
  if (!Number.isInteger(fromSeq) || fromSeq <= 0) {
    throw new StarciteError("Session range reads require fromSeq >= 1.");
  }

  if (!Number.isInteger(toSeq) || toSeq < fromSeq) {
    throw new StarciteError("Session range reads require toSeq >= fromSeq.");
  }
}

function toOrderedEvents(
  eventBySeq: ReadonlyMap<number, TailEvent>
): TailEvent[] {
  return [...eventBySeq.values()].sort((left, right) => left.seq - right.seq);
}

function normalizeBatch(batch: readonly TailEvent[]): TailEvent[] {
  const bySeq = new Map<number, TailEvent>();
  for (const event of batch) {
    bySeq.set(event.seq, event);
  }

  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function toMergedRanges(
  ranges: readonly SessionHistoryRange[]
): SessionHistoryRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort(
    (left, right) => left.fromSeq - right.fromSeq
  );
  const merged: SessionHistoryRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.fromSeq > previous.toSeq + 1) {
      merged.push({ ...range });
      continue;
    }

    previous.toSeq = Math.max(previous.toSeq, range.toSeq);
    if (range.afterCursor !== undefined && range.toSeq >= previous.toSeq) {
      previous.afterCursor = range.afterCursor;
    }
  }

  return merged;
}

function toCheckpointRange(range: SessionHistoryRange): SessionHistoryCoverage {
  return {
    fromSeq: range.fromSeq,
    toSeq: range.toSeq,
    beforeCursor: range.beforeCursor,
    afterCursor: range.afterCursor,
  };
}

/**
 * Canonical sparse in-memory history for one session.
 *
 * The history owns all materialized events and exact seq coverage. Reads should
 * ask it for a seq range directly rather than "ensure, then slice" in two
 * separate phases.
 */
export class SessionHistory {
  private readonly emitter = new EventEmitter<SessionHistoryEvents>();
  private readonly eventBySeq = new Map<number, TailEvent>();
  private ranges: SessionHistoryRange[] = [];
  private observedLastSeq = 0;
  private observedCursor: TailCursor | undefined;

  restore(snapshot: SessionHistoryStoreSnapshot): void {
    const { lastSeq } = snapshot;
    if (!Number.isInteger(lastSeq) || lastSeq < 0) {
      throw new StarciteError(
        "Stored session state lastSeq must be a non-negative integer."
      );
    }

    this.eventBySeq.clear();
    this.ranges = [];
    this.observedLastSeq = lastSeq;
    this.observedCursor = snapshot.cursor;

    const events = snapshot.events ?? [];
    for (const event of normalizeBatch(events)) {
      this.eventBySeq.set(event.seq, event);
    }

    const restoredRanges =
      snapshot.coverage?.map((range) => ({
        fromSeq: range.fromSeq,
        toSeq: range.toSeq,
        beforeCursor: range.beforeCursor,
        afterCursor: range.afterCursor,
      })) ?? this.deriveRangesFromEvents(events);
    this.ranges = toMergedRanges(restoredRanges);
  }

  snapshot(): SessionHistoryStoreSnapshot | undefined {
    if (this.observedLastSeq === 0 && this.observedCursor === undefined) {
      return undefined;
    }

    return {
      lastSeq: this.observedLastSeq,
      cursor: this.observedCursor,
      events: this.eventBySeq.size > 0 ? this.events : undefined,
      coverage:
        this.ranges.length > 0 ? this.ranges.map(toCheckpointRange) : undefined,
    };
  }

  subscribe(
    listener: (
      event: TailEvent,
      context: SessionHistorySubscriptionContext
    ) => void,
    options: { replay?: boolean } = {}
  ): () => void {
    if (options.replay ?? false) {
      for (const event of this.events) {
        listener(event, { replayed: true });
      }
    }

    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  state(syncing: boolean): SessionHistorySnapshot {
    return {
      events: this.events,
      lastSeq: this.observedLastSeq,
      cursor: this.observedCursor,
      syncing,
    };
  }

  applyLiveBatch(
    batch: readonly TailEvent[],
    beforeCursor?: TailCursor
  ): TailEvent[] {
    return this.applyBatch(batch, {
      beforeCursor,
      emit: true,
    });
  }

  applyBackfillBatch(
    batch: readonly TailEvent[],
    beforeCursor: TailCursor
  ): TailEvent[] {
    return this.applyBatch(batch, {
      beforeCursor,
      emit: false,
    });
  }

  markObservedCursor(cursor: TailCursor): void {
    this.observedCursor =
      this.observedCursor === undefined
        ? cursor
        : Math.max(this.observedCursor, cursor);
  }

  isRangeCovered(fromSeq: number, toSeq: number): boolean {
    assertValidRange(fromSeq, toSeq);
    return this.findCoveringRange(fromSeq, toSeq) !== undefined;
  }

  firstMissingRange(
    fromSeq: number,
    toSeq: number
  ): { fromSeq: number; toSeq: number } | undefined {
    assertValidRange(fromSeq, toSeq);
    let nextSeq = fromSeq;

    for (const range of this.ranges) {
      if (range.toSeq < nextSeq) {
        continue;
      }

      if (range.fromSeq > nextSeq) {
        return {
          fromSeq: nextSeq,
          toSeq: Math.min(toSeq, range.fromSeq - 1),
        };
      }

      nextSeq = Math.max(nextSeq, range.toSeq + 1);
      if (nextSeq > toSeq) {
        return undefined;
      }
    }

    return nextSeq <= toSeq ? { fromSeq: nextSeq, toSeq } : undefined;
  }

  readRange(fromSeq: number, toSeq: number): TailEvent[] {
    assertValidRange(fromSeq, toSeq);
    if (!this.findCoveringRange(fromSeq, toSeq)) {
      throw new StarciteError(
        `Session history does not cover seq range ${fromSeq}-${toSeq}.`
      );
    }

    const events: TailEvent[] = [];
    for (let seq = fromSeq; seq <= toSeq; seq += 1) {
      const event = this.eventBySeq.get(seq);
      if (!event) {
        throw new StarciteError(
          `Session history is missing materialized seq ${seq} inside covered range ${fromSeq}-${toSeq}.`
        );
      }
      events.push(event);
    }

    return events;
  }

  get events(): TailEvent[] {
    return toOrderedEvents(this.eventBySeq);
  }

  get cursor(): TailCursor | undefined {
    return this.observedCursor;
  }

  get lastSeq(): number {
    return this.observedLastSeq;
  }

  anchorBeforeSeq(seq: number): { cursor: TailCursor; seq: number } {
    if (!Number.isInteger(seq) || seq <= 0) {
      throw new StarciteError("Session anchors require seq >= 1.");
    }

    if (seq <= 1) {
      return { cursor: 0, seq: 0 };
    }

    for (let index = this.ranges.length - 1; index >= 0; index -= 1) {
      const range = this.ranges[index];
      if (!range || range.toSeq >= seq) {
        continue;
      }

      if (range.afterCursor !== undefined) {
        return {
          cursor: range.afterCursor,
          seq: range.toSeq,
        };
      }
    }

    return { cursor: 0, seq: 0 };
  }

  private findCoveringRange(
    fromSeq: number,
    toSeq: number
  ): SessionHistoryRange | undefined {
    return this.ranges.find((range) => {
      return range.fromSeq <= fromSeq && range.toSeq >= toSeq;
    });
  }

  private applyBatch(
    batch: readonly TailEvent[],
    options: { beforeCursor?: TailCursor; emit: boolean }
  ): TailEvent[] {
    const normalized = normalizeBatch(batch);
    if (normalized.length === 0) {
      return [];
    }

    const applied: TailEvent[] = [];
    const previousLastSeq = this.observedLastSeq;
    let currentGroup: TailEvent[] = [];
    let currentBeforeCursor = options.beforeCursor;

    const flushGroup = (): void => {
      if (currentGroup.length === 0) {
        return;
      }

      const first = currentGroup[0];
      const last = currentGroup.at(-1);
      if (!(first && last)) {
        currentGroup = [];
        return;
      }

      for (const event of currentGroup) {
        this.eventBySeq.set(event.seq, event);
        applied.push(event);
        if (options.emit) {
          this.emitter.emit("event", event, { replayed: false });
        }
      }

      this.ranges = toMergedRanges([
        ...this.ranges,
        {
          fromSeq: first.seq,
          toSeq: last.seq,
          beforeCursor: currentBeforeCursor,
          afterCursor: last.cursor,
        },
      ]);

      currentBeforeCursor = last.cursor;
      currentGroup = [];
    };

    for (const event of normalized) {
      const previous = currentGroup.at(-1);
      if (!previous) {
        currentGroup = [event];
        continue;
      }

      if (event.seq === previous.seq + 1) {
        currentGroup.push(event);
        continue;
      }

      flushGroup();
      currentGroup = [event];
      currentBeforeCursor = undefined;
    }

    flushGroup();

    this.observedLastSeq = Math.max(
      this.observedLastSeq,
      normalized.at(-1)?.seq ?? 0
    );
    const lastCursor = normalized.at(-1)?.cursor;
    if (
      lastCursor !== undefined &&
      normalized[0]?.seq !== undefined &&
      normalized[0].seq > previousLastSeq
    ) {
      this.markObservedCursor(lastCursor);
    }

    return applied;
  }

  private deriveRangesFromEvents(
    events: readonly TailEvent[]
  ): SessionHistoryRange[] {
    const normalized = normalizeBatch(events);
    if (normalized.length === 0) {
      return [];
    }

    const derived: SessionHistoryRange[] = [];
    let current: TailEvent[] = [];

    const flush = (): void => {
      const first = current[0];
      const last = current.at(-1);
      if (!(first && last)) {
        current = [];
        return;
      }

      derived.push({
        fromSeq: first.seq,
        toSeq: last.seq,
        beforeCursor: first.seq === 1 ? 0 : undefined,
        afterCursor: last.cursor,
      });
      current = [];
    };

    for (const event of normalized) {
      const previous = current.at(-1);
      if (!previous || event.seq === previous.seq + 1) {
        current.push(event);
        continue;
      }

      flush();
      current.push(event);
    }

    flush();
    return derived;
  }
}
