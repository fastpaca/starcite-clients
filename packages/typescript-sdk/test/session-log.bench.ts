import { bench, describe } from "vitest";
import { SessionLog } from "../src/session-log";
import { parseTailFrame } from "../src/tail/frame";
import type { TailEvent } from "../src/types";

function makeEvent(seq: number): TailEvent {
  return {
    seq,
    type: "content",
    payload: { text: `frame-${seq}` },
    actor: "agent:planner",
    producer_id: "producer:planner",
    producer_seq: seq,
  };
}

function makeBatch(startSeq: number, size: number): TailEvent[] {
  return Array.from({ length: size }, (_, index) =>
    makeEvent(startSeq + index)
  );
}

const contiguousBatch = makeBatch(1, 500);
const replayBatch = makeBatch(1, 500);
const frameBatch = JSON.stringify(makeBatch(1, 100));

describe("Session log overhead", () => {
  bench("apply contiguous 500-event batch", () => {
    const log = new SessionLog();
    log.applyBatch(contiguousBatch);
  });

  bench("deduplicate replayed 500-event batch", () => {
    const log = new SessionLog();
    log.applyBatch(contiguousBatch);
    log.applyBatch(replayBatch);
  });

  bench("parse a 100-event websocket frame", () => {
    parseTailFrame(frameBatch);
  });
});
