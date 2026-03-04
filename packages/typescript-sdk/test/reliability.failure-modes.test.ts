import { describe, expect, it } from "vitest";
import { SessionLog, SessionLogGapError } from "../src/session-log";
import { TailStream } from "../src/tail/stream";
import type {
  SessionTailOptions,
  StarciteWebSocket,
  StarciteWebSocketEventMap,
  TailEvent,
} from "../src/types";

interface TailEventOptions {
  type?: string;
  text?: string;
  actor?: string;
  payload?: Record<string, unknown>;
}

function makeEvent(seq: number, options: TailEventOptions = {}): TailEvent {
  return {
    seq,
    type: options.type ?? "content",
    payload: options.payload ?? { text: options.text ?? `frame-${seq}` },
    actor: options.actor ?? "agent:planner",
    producer_id: "producer:test",
    producer_seq: seq,
  };
}

class FakeWebSocket implements StarciteWebSocket {
  readonly url: string;

  private readonly listeners = new Map<
    keyof StarciteWebSocketEventMap,
    Set<(event: unknown) => void>
  >();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener<TType extends keyof StarciteWebSocketEventMap>(
    type: TType,
    listener: (event: StarciteWebSocketEventMap[TType]) => void
  ): void {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(listener as (event: unknown) => void);
    this.listeners.set(type, handlers);
  }

  removeEventListener<TType extends keyof StarciteWebSocketEventMap>(
    type: TType,
    listener: (event: StarciteWebSocketEventMap[TType]) => void
  ): void {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }

    handlers.delete(listener as (event: unknown) => void);
    if (handlers.size === 0) {
      this.listeners.delete(type);
    }
  }

  close(): void {
    return;
  }

  emit<TType extends keyof StarciteWebSocketEventMap>(
    type: TType,
    event: StarciteWebSocketEventMap[TType]
  ): void {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(event);
    }
  }
}

async function waitForSocketCount(
  sockets: FakeWebSocket[],
  expectedCount: number
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (sockets.length >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} socket(s); saw ${sockets.length}`
  );
}

function buildTailStream(options: { tailOptions?: SessionTailOptions } = {}): {
  stream: TailStream;
  sockets: FakeWebSocket[];
} {
  const sockets: FakeWebSocket[] = [];

  const stream = new TailStream({
    sessionId: "ses_blog",
    token: "token_blog",
    websocketBaseUrl: "ws://localhost:4000/v1",
    websocketFactory: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    options: options.tailOptions ?? {},
  });

  return { stream, sockets };
}

describe("Reliability failure modes", () => {
  it("1) catches reconnect gaps instead of silently losing messages", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1, { text: "before disconnect" })]);

    expect(() => {
      log.applyBatch([makeEvent(3, { text: "missed while offline" })]);
    }).toThrow(SessionLogGapError);

    log.applyBatch([
      makeEvent(2, { text: "replayed missing message" }),
      makeEvent(3, { text: "live after replay" }),
    ]);

    expect(log.events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("2) deduplicates replayed events after reconnect", () => {
    const log = new SessionLog();

    log.applyBatch([makeEvent(1), makeEvent(2)]);
    const applied = log.applyBatch([makeEvent(2), makeEvent(2), makeEvent(3)]);

    expect(applied.map((event) => event.seq)).toEqual([3]);
    expect(log.events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("3) prevents tool-result drift by enforcing contiguous ordering", () => {
    const log = new SessionLog();

    log.applyBatch([
      makeEvent(1, {
        type: "chat.user.message",
        payload: { text: "run search" },
      }),
    ]);

    expect(() => {
      log.applyBatch([
        makeEvent(3, {
          type: "tool.result",
          payload: { toolCallId: "call_1", output: "42" },
        }),
      ]);
    }).toThrow(SessionLogGapError);

    log.applyBatch([
      makeEvent(2, {
        type: "tool.call",
        payload: { toolCallId: "call_1", name: "search" },
      }),
      makeEvent(3, {
        type: "tool.result",
        payload: { toolCallId: "call_1", output: "42" },
      }),
    ]);

    expect(log.events.map((event) => event.type)).toEqual([
      "chat.user.message",
      "tool.call",
      "tool.result",
    ]);
  });

  it("4) preserves one global order across multi-agent writers", () => {
    const log = new SessionLog();

    log.applyBatch([
      makeEvent(1, { actor: "agent:planner", text: "plan" }),
      makeEvent(2, { actor: "agent:researcher", text: "sources" }),
      makeEvent(3, { actor: "agent:planner", text: "draft" }),
    ]);

    expect(log.events.map((event) => `${event.seq}:${event.actor}`)).toEqual([
      "1:agent:planner",
      "2:agent:researcher",
      "3:agent:planner",
    ]);
  });

  it("5) replays identical history to multiple subscribers (tab convergence)", () => {
    const log = new SessionLog();
    const firstTabSeqs: number[] = [];
    const secondTabSeqs: number[] = [];

    log.applyBatch([makeEvent(1), makeEvent(2)]);

    const stopFirstTab = log.subscribe((event) => {
      firstTabSeqs.push(event.seq);
    });
    const stopSecondTab = log.subscribe((event) => {
      secondTabSeqs.push(event.seq);
    });

    log.applyBatch([makeEvent(3)]);

    expect(firstTabSeqs).toEqual([1, 2, 3]);
    expect(secondTabSeqs).toEqual([1, 2, 3]);

    stopFirstTab();
    stopSecondTab();
  });

  it("6) reconnects across deploy-style drops and resumes from cursor", async () => {
    const batches: TailEvent[][] = [];
    const { stream, sockets } = buildTailStream({
      tailOptions: {
        reconnect: true,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
          maxAttempts: 1,
          jitterRatio: 0,
        },
      },
    });

    const subscribePromise = stream.subscribe((batch) => {
      batches.push(batch);
    });

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("open", undefined);
    sockets[0]?.emit("message", { data: JSON.stringify(makeEvent(1)) });
    sockets[0]?.emit("close", { code: 1006, reason: "deployment restart" });

    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toContain("cursor=1");

    sockets[1]?.emit("open", undefined);
    sockets[1]?.emit("message", { data: JSON.stringify(makeEvent(2)) });
    sockets[1]?.emit("close", { code: 1000, reason: "done" });

    await subscribePromise;

    expect(batches.flat().map((event) => event.seq)).toEqual([1, 2]);
  });
});
