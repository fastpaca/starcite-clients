import { describe, expect, it } from "vitest";
import { StarciteError } from "../src/errors";
import { SessionLog } from "../src/session-log";
import type { TailCursor, TailEvent } from "../src/types";

function makeEvent(
  seq: number,
  text = `frame-${seq}`,
  cursor?: TailCursor
): TailEvent {
  return {
    seq,
    cursor,
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

    const applied = log.applyBatch([
      makeEvent(1, "frame-1", 1),
      makeEvent(2, "frame-2", 2),
    ]);

    expect(applied.map((event) => event.seq)).toEqual([1, 2]);
    expect(log.lastSeq).toBe(2);
    expect(log.state(false)).toMatchObject({
      cursor: 2,
      lastSeq: 2,
      syncing: false,
    });
    expect(log.state(false).events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("anchors the log on the first observed event even when the sequence starts later", () => {
    const log = new SessionLog();
    const applied = log.applyBatch([makeEvent(2, "frame-2", 2)]);

    expect(applied.map((event) => event.seq)).toEqual([2]);
    expect(log.state(false)).toMatchObject({
      cursor: 2,
      lastSeq: 2,
      syncing: false,
    });
  });

  it("accepts later observed events without requiring contiguous history", () => {
    const log = new SessionLog();
    log.applyBatch([makeEvent(2)]);
    const applied = log.applyBatch([makeEvent(4)]);

    expect(applied.map((event) => event.seq)).toEqual([4]);
    expect(log.state(false).events.map((event) => event.seq)).toEqual([2, 4]);
    expect(log.lastSeq).toBe(4);
  });

  it("overwrites same-seq redeliveries with server truth", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1)]);
    const applied = log.applyBatch([makeEvent(1, "updated")]);

    expect(applied.map((event) => event.seq)).toEqual([1]);
    expect(log.state(false).events).toEqual([makeEvent(1, "updated")]);
  });

  it("applies mixed existing/new batches and returns all applied events", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1), makeEvent(2)]);
    const applied = log.applyBatch([makeEvent(2), makeEvent(3), makeEvent(4)]);

    expect(applied.map((event) => event.seq)).toEqual([2, 3, 4]);
    expect(log.state(false).events.map((event) => event.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("keeps exposed history sorted by seq even when events arrive out of order", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(5), makeEvent(3), makeEvent(4)]);

    expect(log.state(false).events.map((event) => event.seq)).toEqual([
      3, 4, 5,
    ]);
    expect(log.events.map((event) => event.seq)).toEqual([3, 4, 5]);
  });

  it("overwrites previously retained events when the server sends updated truth", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1, "first")]);
    const applied = log.applyBatch([makeEvent(1, "different payload")]);

    expect(applied.map((event) => event.seq)).toEqual([1]);
    expect(log.state(false).events).toEqual([
      makeEvent(1, "different payload"),
    ]);
  });

  it("restores sparse cached checkpoints without requiring contiguous retained events", () => {
    const log = new SessionLog();

    log.restore({
      cursor: 6,
      events: [makeEvent(6, "frame-6", 6)],
      lastSeq: 6,
    });

    expect(log.state(false)).toMatchObject({
      cursor: 6,
      lastSeq: 6,
      syncing: false,
    });
    expect(log.state(false).events.map((event) => event.seq)).toEqual([6]);
  });

  it("does not infer a known session head from a stored cursor alone", () => {
    const log = new SessionLog();

    log.restore({
      cursor: 9,
      events: [],
      lastSeq: 0,
    });

    expect(log.cursor).toBe(9);
    expect(log.hasKnownLastSeq).toBe(false);
    expect(log.canServeLast(1)).toBe(false);
  });

  it("replays retained history to new subscribers", () => {
    const log = new SessionLog();
    const replayedSeqs: number[] = [];

    log.applyBatch([makeEvent(1), makeEvent(2), makeEvent(3)]);

    log.subscribe((event) => {
      replayedSeqs.push(event.seq);
    });

    expect(replayedSeqs).toEqual([1, 2, 3]);
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

  it("tracks missing sparse ranges and last-window availability independently from observed seqs", () => {
    const log = new SessionLog();

    log.restore({
      lastSeq: 10,
      lastSeqKnown: true,
      events: [makeEvent(2), makeEvent(3), makeEvent(9), makeEvent(10)],
    });

    expect(log.missingRanges(1, 10)).toEqual([
      { fromSeq: 1, toSeq: 1 },
      { fromSeq: 4, toSeq: 8 },
    ]);
    expect(log.canServeLast(2)).toBe(true);
    expect(log.canServeLast(3)).toBe(false);
  });

  it("treats fetched history as sparse cache population instead of live replay", () => {
    const log = new SessionLog();
    const seenSeqs: number[] = [];

    const unsubscribe = log.subscribe(
      (event) => {
        seenSeqs.push(event.seq);
      },
      { replay: false }
    );

    log.mergeHistory([makeEvent(8), makeEvent(9)]);

    expect(seenSeqs).toEqual([]);
    expect(log.lastSeq).toBe(9);
    expect(log.hasKnownLastSeq).toBe(false);
    expect(log.cursor).toBeUndefined();

    unsubscribe();
  });

  it("marks the log fully loaded when history covers the complete known seq range", () => {
    const log = new SessionLog();

    log.mergeHistory([makeEvent(1), makeEvent(2), makeEvent(3)], {
      lastSeqKnown: true,
    });

    expect(log.hasKnownLastSeq).toBe(true);
    expect(log.isFullyLoaded).toBe(true);
    expect(log.canServeLast(3)).toBe(true);
  });

  it("preserves explicit fully loaded checkpoints even when the earliest seq is greater than one", () => {
    const log = new SessionLog();

    log.restore({
      lastSeq: 7,
      lastSeqKnown: true,
      fullyLoaded: true,
      loadedRanges: [{ fromSeq: 5, toSeq: 7 }],
      events: [makeEvent(5), makeEvent(6), makeEvent(7)],
    });

    expect(log.hasKnownLastSeq).toBe(true);
    expect(log.isFullyLoaded).toBe(true);
    expect(log.events.map((event) => event.seq)).toEqual([5, 6, 7]);
  });

  it("keeps explicit fully loaded state when a live append extends the head contiguously", () => {
    const log = new SessionLog();

    log.restore({
      lastSeq: 7,
      lastSeqKnown: true,
      fullyLoaded: true,
      loadedRanges: [{ fromSeq: 5, toSeq: 7 }],
      events: [makeEvent(5), makeEvent(6), makeEvent(7)],
    });

    log.applyBatch([makeEvent(8, "frame-8", 8)]);

    expect(log.isFullyLoaded).toBe(true);
    expect(log.events.map((event) => event.seq)).toEqual([5, 6, 7, 8]);
  });

  it("drops explicit fully loaded state when a live append creates a gap", () => {
    const log = new SessionLog();

    log.restore({
      lastSeq: 7,
      lastSeqKnown: true,
      fullyLoaded: true,
      loadedRanges: [{ fromSeq: 5, toSeq: 7 }],
      events: [makeEvent(5), makeEvent(6), makeEvent(7)],
    });

    log.applyBatch([makeEvent(10, "frame-10", 10)]);

    expect(log.isFullyLoaded).toBe(false);
    expect(log.missingRanges(5, 10)).toEqual([{ fromSeq: 8, toSeq: 9 }]);
  });

  it("invalidates head knowledge when the log becomes sparse again", () => {
    const log = new SessionLog();

    log.mergeHistory([makeEvent(1), makeEvent(2), makeEvent(3)], {
      lastSeqKnown: true,
    });
    expect(log.isFullyLoaded).toBe(true);

    log.markSparse();

    expect(log.isFullyLoaded).toBe(false);
    expect(log.hasKnownLastSeq).toBe(false);
    expect(log.canServeLast(1)).toBe(false);
  });

  it("does not retain partial state when checkpoint validation fails", () => {
    const log = new SessionLog();

    expect(() => {
      log.restore({
        lastSeq: 1,
        events: [makeEvent(2, "invalid cached event")],
      });
    }).toThrow(StarciteError);

    expect(log.lastSeq).toBe(0);
    expect(log.events).toEqual([]);
  });

  it("does not retain partial state when a restored checkpoint has any invalid seq", () => {
    const log = new SessionLog();

    expect(() => {
      log.restore({
        lastSeq: 2,
        events: [makeEvent(1), makeEvent(3), makeEvent(4)],
      });
    }).toThrow(StarciteError);

    expect(log.lastSeq).toBe(0);
    expect(log.events).toEqual([]);
  });

  it("infers fully loaded state when a restored checkpoint covers the full known log", () => {
    const log = new SessionLog();

    log.restore({
      lastSeq: 2,
      lastSeqKnown: true,
      events: [makeEvent(1), makeEvent(2)],
    });

    expect(log.hasKnownLastSeq).toBe(true);
    expect(log.isFullyLoaded).toBe(true);
  });
});
