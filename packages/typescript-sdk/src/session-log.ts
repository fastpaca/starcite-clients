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

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortCanonicalValue(entry));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(
      ([_key, entryValue]) => entryValue !== undefined
    );
    entries.sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, sortCanonicalValue(entryValue)])
    );
  }

  return value;
}

function normalizeOptionalObject(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = sortCanonicalValue(value);
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    return undefined;
  }

  return Object.keys(normalized).length > 0
    ? (normalized as Record<string, unknown>)
    : undefined;
}

function normalizeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  const { starcite_principal: _starcitePrincipal, ...rest } = metadata;
  return normalizeOptionalObject(rest);
}

function canonicalizeEvent(event: TailEvent): string {
  return JSON.stringify(
    sortCanonicalValue({
      seq: event.seq,
      type: event.type,
      payload: event.payload,
      actor: event.actor,
      producer_id: event.producer_id,
      producer_seq: event.producer_seq,
      source: event.source,
      metadata: normalizeMetadata(event.metadata),
      refs: normalizeOptionalObject(event.refs),
      idempotency_key: event.idempotency_key,
    })
  );
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
        this.emitter.emit("event", event);
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

    const nextHistory: TailEvent[] = [];
    const nextCanonicalBySeq = new Map<number, string>();
    let previousSeq: number | undefined;
    for (const event of state.events) {
      if (event.seq > state.lastSeq) {
        throw new StarciteError(
          `Session store contains event seq ${event.seq} above lastSeq ${state.lastSeq}`
        );
      }

      if (previousSeq !== undefined && event.seq !== previousSeq + 1) {
        throw new StarciteError(
          `Session store events must be contiguous; saw seq ${event.seq} after ${previousSeq}`
        );
      }

      nextHistory.push(event);
      nextCanonicalBySeq.set(event.seq, canonicalizeEvent(event));
      previousSeq = event.seq;
    }

    const latestEvent = nextHistory.at(-1);

    this.history.length = 0;
    this.history.push(...nextHistory);
    this.canonicalBySeq.clear();
    for (const [seq, canonical] of nextCanonicalBySeq.entries()) {
      this.canonicalBySeq.set(seq, canonical);
    }
    this.appliedSeq = state.lastSeq;
    if (state.cursor) {
      this.appliedCursor = { ...state.cursor };
    } else if (latestEvent?.cursor) {
      this.appliedCursor = { ...latestEvent.cursor };
    } else {
      this.appliedCursor = undefined;
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
      const incomingCanonical = canonicalizeEvent(event);
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
    this.canonicalBySeq.set(event.seq, canonicalizeEvent(event));
    this.appliedSeq = event.seq;
    if (event.cursor) {
      this.appliedCursor = { ...event.cursor };
    }
    this.enforceRetention();
    return true;
  }

  state(syncing: boolean): SessionSnapshot {
    return {
      events: this.history.slice(),
      lastSeq: this.appliedSeq,
      cursor: this.appliedCursor ? { ...this.appliedCursor } : undefined,
      syncing,
    };
  }

  get events(): readonly TailEvent[] {
    return this.history.slice();
  }

  get cursor(): TailCursor | undefined {
    return this.appliedCursor ? { ...this.appliedCursor } : undefined;
  }

  get lastSeq(): number {
    return this.appliedSeq;
  }

  advanceCursor(cursor: TailCursor): void {
    this.appliedCursor = { ...cursor };
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
