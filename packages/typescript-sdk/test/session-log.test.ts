import { describe, expect, it } from "vitest";
import { StarciteError } from "../src/errors";
import {
  SessionLog,
  SessionLogConflictError,
  SessionLogGapError,
} from "../src/session-log";
import type { TailEvent } from "../src/types";

function makeEvent(seq: number, text = `frame-${seq}`): TailEvent {
  return {
    seq,
    type: "content",
    payload: { text },
    actor: "agent:drafter",
    producer_id: "producer:drafter",
    producer_seq: seq,
  };
}

describe("SessionLog", () => {
  it("applies contiguous batches and exposes snapshot state", () => {
    const log = new SessionLog();

    const applied = log.applyBatch([makeEvent(1), makeEvent(2)]);

    expect(applied.map((event) => event.seq)).toEqual([1, 2]);
    expect(log.lastSeq).toBe(2);
    expect(log.getSnapshot(false)).toMatchObject({
      lastSeq: 2,
      syncing: false,
    });
    expect(log.getSnapshot(false).events.map((event) => event.seq)).toEqual([
      1, 2,
    ]);
  });

  it("throws SessionLogGapError when sequence numbers skip", () => {
    const log = new SessionLog();

    expect(() => {
      log.applyBatch([makeEvent(2)]);
    }).toThrow(SessionLogGapError);
  });

  it("deduplicates identical repeated events", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1)]);
    const applied = log.applyBatch([makeEvent(1)]);

    expect(applied).toEqual([]);
    expect(log.getSnapshot(false).events.map((event) => event.seq)).toEqual([
      1,
    ]);
  });

  it("applies mixed duplicate/new batches and returns only newly applied events", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1), makeEvent(2)]);
    const applied = log.applyBatch([makeEvent(2), makeEvent(3), makeEvent(4)]);

    expect(applied.map((event) => event.seq)).toEqual([3, 4]);
    expect(log.getSnapshot(false).events.map((event) => event.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("throws SessionLogConflictError for conflicting duplicates", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1, "first")]);

    expect(() => {
      log.applyBatch([makeEvent(1, "different payload")]);
    }).toThrow(SessionLogConflictError);
  });

  it("replays retained history to new subscribers", () => {
    const log = new SessionLog({ maxEvents: 2 });
    const replayedSeqs: number[] = [];

    log.applyBatch([makeEvent(1), makeEvent(2), makeEvent(3)]);

    log.subscribe((event) => {
      replayedSeqs.push(event.seq);
    });

    expect(replayedSeqs).toEqual([2, 3]);
  });

  it("supports non-replay subscriptions for future events only", () => {
    const log = new SessionLog();
    const observedSeqs: number[] = [];

    log.applyBatch([makeEvent(1), makeEvent(2)]);

    const unsubscribe = log.subscribe(
      (event) => {
        observedSeqs.push(event.seq);
      },
      { replay: false }
    );

    expect(observedSeqs).toEqual([]);

    log.applyBatch([makeEvent(3)]);
    expect(observedSeqs).toEqual([3]);

    unsubscribe();
    log.applyBatch([makeEvent(4)]);
    expect(observedSeqs).toEqual([3]);
  });

  it("ignores duplicates older than retained history", () => {
    const log = new SessionLog({ maxEvents: 2 });

    log.applyBatch([makeEvent(1), makeEvent(2), makeEvent(3)]);

    const applied = log.applyBatch([makeEvent(1)]);

    expect(applied).toEqual([]);
    expect(log.getSnapshot(false).events.map((event) => event.seq)).toEqual([
      2, 3,
    ]);
  });

  it("ignores conflicting duplicates that are older than retained history", () => {
    const log = new SessionLog({ maxEvents: 2 });

    log.applyBatch([makeEvent(1, "first"), makeEvent(2), makeEvent(3)]);

    expect(() => {
      log.applyBatch([makeEvent(1, "different")]);
    }).not.toThrow();
    expect(log.getSnapshot(false).events.map((event) => event.seq)).toEqual([
      2, 3,
    ]);
  });

  it("trims retained history when maxEvents is lowered at runtime", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4)]);
    log.setMaxEvents(2);

    expect(log.getSnapshot(false).events.map((event) => event.seq)).toEqual([
      3, 4,
    ]);
  });

  it("rejects invalid maxEvents values", () => {
    expect(() => new SessionLog({ maxEvents: 0 })).toThrow(StarciteError);

    const log = new SessionLog();
    expect(() => {
      log.setMaxEvents(-1);
    }).toThrow(StarciteError);
    expect(() => {
      log.setMaxEvents(1.5);
    }).toThrow(StarciteError);
  });
});
