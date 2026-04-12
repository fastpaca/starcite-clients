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
      lastSeq: 6,
    });

    expect(log.state(false)).toMatchObject({
      cursor: 6,
      lastSeq: 6,
      syncing: false,
    });
    expect(log.state(false).events).toEqual([]);
  });

  it("replays retained history to new subscribers", () => {
    const log = new SessionLog();
    const replayedSeqs: number[] = [];

    log.applyBatch([makeEvent(1), makeEvent(2), makeEvent(3)]);

    log.subscribe(
      (event) => {
        replayedSeqs.push(event.seq);
      },
      { replay: true }
    );

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

  it("observes fetched reads without emitting live events", () => {
    const log = new SessionLog();
    const observedSeqs: number[] = [];

    log.subscribe((event) => {
      observedSeqs.push(event.seq);
    });

    const applied = log.observeRead({
      events: [makeEvent(9, "frame-9", 9), makeEvent(10, "frame-10", 10)],
      next_cursor: 10,
      last_seq: 10,
    });

    expect(applied.map((event) => event.seq)).toEqual([9, 10]);
    expect(observedSeqs).toEqual([]);
    expect(log.state(false)).toMatchObject({
      cursor: 10,
      lastSeq: 10,
      syncing: false,
    });
    expect(log.events.map((event) => event.seq)).toEqual([9, 10]);
  });

  it("can checkpoint cursor state without persisting materialized events", () => {
    const log = new SessionLog();

    log.observeRead({
      events: [makeEvent(5, "frame-5", 5)],
      next_cursor: 5,
      last_seq: 5,
    });

    expect(log.checkpoint()).toEqual({
      cursor: 5,
      lastSeq: 5,
    });
  });

  it("does not retain partial state when checkpoint validation fails", () => {
    const log = new SessionLog();

    expect(() => {
      log.restore({
        lastSeq: -1,
      });
    }).toThrow(StarciteError);

    expect(log.lastSeq).toBe(0);
    expect(log.events).toEqual([]);
  });
});
