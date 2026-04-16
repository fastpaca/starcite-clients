import { describe, expect, it } from "vitest";
import { StarciteError } from "../src/errors";
import { SessionHistory } from "../src/session-history";
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

describe("SessionHistory", () => {
  it("applies contiguous live batches and exposes snapshot state", () => {
    const history = new SessionHistory();

    const applied = history.applyLiveBatch([
      makeEvent(1, "frame-1", 1),
      makeEvent(2, "frame-2", 2),
    ]);

    expect(applied.map((event) => event.seq)).toEqual([1, 2]);
    expect(history.lastSeq).toBe(2);
    expect(history.state(false)).toMatchObject({
      cursor: 2,
      lastSeq: 2,
      syncing: false,
    });
    expect(history.state(false).events.map((event) => event.seq)).toEqual([
      1, 2,
    ]);
    expect(history.readRange(1, 2).map((event) => event.seq)).toEqual([1, 2]);
  });

  it("anchors sparse retained ranges even when the first observed seq starts later", () => {
    const history = new SessionHistory();
    const applied = history.applyLiveBatch([makeEvent(2, "frame-2", 2)]);

    expect(applied.map((event) => event.seq)).toEqual([2]);
    expect(history.state(false)).toMatchObject({
      cursor: 2,
      lastSeq: 2,
      syncing: false,
    });
    expect(history.isRangeCovered(2, 2)).toBe(true);
    expect(history.isRangeCovered(1, 2)).toBe(false);
  });

  it("accepts sparse later events without pretending the gap is covered", () => {
    const history = new SessionHistory();
    history.applyLiveBatch([makeEvent(2)]);
    const applied = history.applyLiveBatch([makeEvent(4)]);

    expect(applied.map((event) => event.seq)).toEqual([4]);
    expect(history.state(false).events.map((event) => event.seq)).toEqual([
      2, 4,
    ]);
    expect(history.lastSeq).toBe(4);
    expect(history.firstMissingRange(2, 4)).toEqual({
      fromSeq: 3,
      toSeq: 3,
    });
  });

  it("overwrites same-seq redeliveries with server truth", () => {
    const history = new SessionHistory();

    history.applyLiveBatch([makeEvent(1)]);
    const applied = history.applyLiveBatch([makeEvent(1, "updated")]);

    expect(applied.map((event) => event.seq)).toEqual([1]);
    expect(history.state(false).events).toEqual([makeEvent(1, "updated")]);
  });

  it("applies mixed existing/new batches and returns all applied events", () => {
    const history = new SessionHistory();

    history.applyLiveBatch([makeEvent(1), makeEvent(2)]);
    const applied = history.applyLiveBatch([
      makeEvent(2),
      makeEvent(3),
      makeEvent(4),
    ]);

    expect(applied.map((event) => event.seq)).toEqual([2, 3, 4]);
    expect(history.state(false).events.map((event) => event.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("keeps exposed history sorted by seq even when events arrive out of order", () => {
    const history = new SessionHistory();

    history.applyLiveBatch([makeEvent(5), makeEvent(3), makeEvent(4)]);

    expect(history.state(false).events.map((event) => event.seq)).toEqual([
      3, 4, 5,
    ]);
    expect(history.events.map((event) => event.seq)).toEqual([3, 4, 5]);
  });

  it("overwrites previously retained events when the server sends updated truth", () => {
    const history = new SessionHistory();

    history.applyLiveBatch([makeEvent(1, "first")]);
    const applied = history.applyLiveBatch([makeEvent(1, "different payload")]);

    expect(applied.map((event) => event.seq)).toEqual([1]);
    expect(history.state(false).events).toEqual([
      makeEvent(1, "different payload"),
    ]);
  });

  it("restores sparse cached checkpoints with explicit coverage ranges", () => {
    const history = new SessionHistory();

    history.restore({
      cursor: 6,
      lastSeq: 6,
      events: [makeEvent(2, "frame-2", 2), makeEvent(5, "frame-5", 5)],
      coverage: [
        { fromSeq: 2, toSeq: 2, afterCursor: 2 },
        { fromSeq: 5, toSeq: 5, afterCursor: 5 },
      ],
    });

    expect(history.state(false)).toMatchObject({
      cursor: 6,
      lastSeq: 6,
      syncing: false,
    });
    expect(history.state(false).events.map((event) => event.seq)).toEqual([
      2, 5,
    ]);
    expect(history.isRangeCovered(2, 2)).toBe(true);
    expect(history.isRangeCovered(5, 5)).toBe(true);
    expect(history.isRangeCovered(2, 5)).toBe(false);
  });

  it("replays retained history to new subscribers", () => {
    const history = new SessionHistory();
    const replayedSeqs: number[] = [];

    history.applyLiveBatch([makeEvent(1), makeEvent(2), makeEvent(3)]);

    history.observe(
      (event) => {
        replayedSeqs.push(event.seq);
      },
      { replay: true }
    );

    expect(replayedSeqs).toEqual([1, 2, 3]);
  });

  it("supports non-replay subscriptions for future events only", () => {
    const history = new SessionHistory();
    const observedSeqs: number[] = [];

    history.applyLiveBatch([makeEvent(1), makeEvent(2)]);

    const unsubscribe = history.observe(
      (event) => {
        observedSeqs.push(event.seq);
      },
      { replay: false }
    );

    expect(observedSeqs).toEqual([]);

    history.applyLiveBatch([makeEvent(3)]);
    expect(observedSeqs).toEqual([3]);

    unsubscribe();
    history.applyLiveBatch([makeEvent(4)]);
    expect(observedSeqs).toEqual([3]);
  });

  it("applies backfill batches without emitting live events", () => {
    const history = new SessionHistory();
    const observedSeqs: number[] = [];

    history.observe((event) => {
      observedSeqs.push(event.seq);
    });

    const applied = history.applyBackfillBatch(
      [makeEvent(9, "frame-9", 9), makeEvent(10, "frame-10", 10)],
      8
    );

    expect(applied.map((event) => event.seq)).toEqual([9, 10]);
    expect(observedSeqs).toEqual([]);
    history.markObservedCursor(10);
    expect(history.state(false)).toMatchObject({
      cursor: 10,
      lastSeq: 10,
      syncing: false,
    });
    expect(history.events.map((event) => event.seq)).toEqual([9, 10]);
    expect(history.anchorBeforeSeq(11)).toEqual({ cursor: 10, seq: 10 });
  });

  it("exports a single stored snapshot for durable state and warm events", () => {
    const history = new SessionHistory();
    history.applyBackfillBatch([makeEvent(5, "frame-5", 5)], 4);
    history.markObservedCursor(5);

    expect(history.snapshot()).toEqual({
      cursor: 5,
      lastSeq: 5,
      events: [makeEvent(5, "frame-5", 5)],
      coverage: [{ fromSeq: 5, toSeq: 5, beforeCursor: 4, afterCursor: 5 }],
    });
  });

  it("does not retain partial state when checkpoint validation fails", () => {
    const history = new SessionHistory();

    expect(() => {
      history.restore({
        lastSeq: -1,
      });
    }).toThrow(StarciteError);

    expect(history.lastSeq).toBe(0);
    expect(history.events).toEqual([]);
  });

  it("rejects invalid range requests at the invariant boundary", () => {
    const history = new SessionHistory();

    expect(() => history.isRangeCovered(0, 1)).toThrow(StarciteError);
    expect(() => history.firstMissingRange(3, 2)).toThrow(StarciteError);
    expect(() => history.anchorBeforeSeq(0)).toThrow(StarciteError);
  });
});
