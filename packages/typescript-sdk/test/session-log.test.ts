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
      makeEvent(1, "frame-1", { epoch: 1, seq: 1 }),
      makeEvent(2, "frame-2", { epoch: 1, seq: 2 }),
    ]);

    expect(applied.map((event) => event.seq)).toEqual([1, 2]);
    expect(log.lastSeq).toBe(2);
    expect(log.state(false)).toMatchObject({
      cursor: { epoch: 1, seq: 2 },
      lastSeq: 2,
      syncing: false,
    });
    expect(log.state(false).events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("anchors the log on the first observed event even when the sequence starts later", () => {
    const log = new SessionLog();
    const applied = log.applyBatch([makeEvent(2, "frame-2", { epoch: 1, seq: 2 })]);

    expect(applied.map((event) => event.seq)).toEqual([2]);
    expect(log.state(false)).toMatchObject({
      cursor: { epoch: 1, seq: 2 },
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

  it("deduplicates identical repeated events", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1)]);
    const applied = log.applyBatch([makeEvent(1)]);

    expect(applied).toEqual([]);
    expect(log.state(false).events.map((event) => event.seq)).toEqual([1]);
  });

  it("applies mixed duplicate/new batches and returns only newly applied events", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1), makeEvent(2)]);
    const applied = log.applyBatch([makeEvent(2), makeEvent(3), makeEvent(4)]);

    expect(applied.map((event) => event.seq)).toEqual([3, 4]);
    expect(log.state(false).events.map((event) => event.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("overwrites previously retained events when the server sends updated truth", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1, "first")]);
    const applied = log.applyBatch([makeEvent(1, "different payload")]);

    expect(applied.map((event) => event.seq)).toEqual([1]);
    expect(log.state(false).events).toEqual([makeEvent(1, "different payload")]);
  });

  it("hydrates sparse persisted state without requiring contiguous retained events", () => {
    const log = new SessionLog();

    log.hydrate({
      cursor: { epoch: 3, seq: 6 },
      events: [makeEvent(6, "frame-6", { epoch: 3, seq: 6 })],
      lastSeq: 6,
    });

    expect(log.state(false)).toMatchObject({
      cursor: { epoch: 3, seq: 6 },
      lastSeq: 6,
      syncing: false,
    });
    expect(log.state(false).events.map((event) => event.seq)).toEqual([6]);
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
    expect(log.state(false).events.map((event) => event.seq)).toEqual([2, 3]);
  });

  it("ignores conflicting duplicates that are older than retained history", () => {
    const log = new SessionLog({ maxEvents: 2 });

    log.applyBatch([makeEvent(1, "first"), makeEvent(2), makeEvent(3)]);

    expect(() => {
      log.applyBatch([makeEvent(1, "different")]);
    }).not.toThrow();
    expect(log.state(false).events.map((event) => event.seq)).toEqual([2, 3]);
  });

  it("trims retained history when maxEvents is lowered at runtime", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4)]);
    log.setMaxEvents(2);

    expect(log.state(false).events.map((event) => event.seq)).toEqual([3, 4]);
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

  it("does not retain partial state when hydrate validation fails", () => {
    const log = new SessionLog();

    expect(() => {
      log.hydrate({
        lastSeq: 1,
        events: [makeEvent(2, "invalid cached event")],
      });
    }).toThrow(StarciteError);

    expect(log.lastSeq).toBe(0);
    expect(log.events).toEqual([]);
  });
});
