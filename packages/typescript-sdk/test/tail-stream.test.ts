import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StarciteRetryLimitError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "../src/errors";
import { TailStream } from "../src/tail/stream";
import type {
  SessionTailOptions,
  StarciteWebSocket,
  StarciteWebSocketEventMap,
  TailLifecycleEvent,
} from "../src/types";

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
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (sockets.length >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} socket(s); saw ${sockets.length}`
  );
}

function buildTailStream(
  options: {
    tailOptions?: SessionTailOptions;
    websocketFactory?: (url: string) => StarciteWebSocket;
    websocketAuthTransport?: "header" | "access_token";
    token?: string;
  } = {}
) {
  const sockets: FakeWebSocket[] = [];

  const stream = new TailStream({
    sessionId: "ses_tail",
    token: options.token ?? "token_123",
    websocketBaseUrl: "ws://localhost:4000/v1",
    websocketFactory:
      options.websocketFactory ??
      ((url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      }),
    websocketAuthTransport: options.websocketAuthTransport ?? "header",
    options: options.tailOptions ?? {},
  });

  return { stream, sockets };
}

describe("TailStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails with connect-stage StarciteTailError when websocket creation fails", async () => {
    const { stream, sockets } = buildTailStream({
      websocketFactory: () => {
        throw new Error("dial failed");
      },
      tailOptions: {
        reconnect: false,
      },
    });

    const subscribePromise = stream.subscribe(() => undefined);
    const tailError = (await subscribePromise.catch(
      (error) => error
    )) as StarciteTailError;

    expect(tailError).toBeInstanceOf(StarciteTailError);
    expect(tailError.stage).toBe("connect");
    expect(tailError.sessionId).toBe("ses_tail");
    expect(tailError.attempts).toBe(0);
    expect(sockets).toHaveLength(0);
  });

  it("raises StarciteTokenExpiredError when close code 4001 is observed", async () => {
    const { stream, sockets } = buildTailStream();

    const subscribePromise = stream.subscribe(() => undefined);
    const rejection = subscribePromise.catch((error) => error);
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 4001, reason: "token_expired" });

    const tailError = (await rejection) as StarciteTokenExpiredError;
    expect(tailError).toBeInstanceOf(StarciteTokenExpiredError);
    expect(tailError.closeCode).toBe(4001);
    expect(tailError.closeReason).toBe("token_expired");
    expect(tailError.sessionId).toBe("ses_tail");
  });

  it("emits stream_ended with caught_up reason for follow=false", async () => {
    vi.useFakeTimers();

    const lifecycleEvents: TailLifecycleEvent[] = [];
    const { stream, sockets } = buildTailStream({
      tailOptions: {
        follow: false,
        catchUpIdleMs: 10,
        onLifecycleEvent: (event) => {
          lifecycleEvents.push(event);
        },
      },
    });

    const subscribePromise = stream.subscribe(() => undefined);
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("open", undefined);
    await vi.advanceTimersByTimeAsync(11);
    await subscribePromise;

    expect(lifecycleEvents[0]).toMatchObject({
      type: "connect_attempt",
      sessionId: "ses_tail",
      attempt: 1,
      cursor: 0,
    });
    expect(lifecycleEvents.at(-1)).toMatchObject({
      type: "stream_ended",
      sessionId: "ses_tail",
      reason: "caught_up",
    });
  });

  it("propagates lifecycle callback exceptions before socket connection", async () => {
    const { stream, sockets } = buildTailStream({
      tailOptions: {
        reconnect: false,
        onLifecycleEvent: () => {
          throw new Error("lifecycle observer failed");
        },
      },
    });

    await expect(stream.subscribe(() => undefined)).rejects.toThrow(
      "lifecycle observer failed"
    );
    expect(sockets).toHaveLength(0);
  });

  it("emits stream_ended with aborted reason when the signal is cancelled", async () => {
    const controller = new AbortController();
    const lifecycleEvents: TailLifecycleEvent[] = [];
    const { stream, sockets } = buildTailStream({
      tailOptions: {
        signal: controller.signal,
        onLifecycleEvent: (event) => {
          lifecycleEvents.push(event);
        },
      },
    });

    const subscribePromise = stream.subscribe(() => undefined);
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("open", undefined);
    controller.abort();
    await subscribePromise;

    expect(lifecycleEvents.at(-1)).toMatchObject({
      type: "stream_ended",
      sessionId: "ses_tail",
      reason: "aborted",
    });
  });

  it("maps connection timeout to stream-stage StarciteTailError", async () => {
    vi.useFakeTimers();

    const { stream, sockets } = buildTailStream({
      tailOptions: {
        reconnect: false,
        connectionTimeoutMs: 20,
      },
    });

    const subscribePromise = stream.subscribe(() => undefined);
    const rejection = subscribePromise.catch((error) => error);
    await waitForSocketCount(sockets, 1);

    await vi.advanceTimersByTimeAsync(21);

    const tailError = (await rejection) as StarciteTailError;
    expect(tailError).toBeInstanceOf(StarciteTailError);
    expect(tailError.stage).toBe("stream");
    expect(tailError.closeCode).toBe(4100);
    expect(tailError.closeReason).toBe("connection timeout");
    expect(tailError.sessionId).toBe("ses_tail");
  });

  it("emits reconnect_scheduled lifecycle events for connect_failed retries", async () => {
    const lifecycleEvents: TailLifecycleEvent[] = [];
    const sockets: FakeWebSocket[] = [];
    let shouldFail = true;

    const { stream } = buildTailStream({
      websocketFactory: (url) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("dial failed");
        }

        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      tailOptions: {
        reconnect: true,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
          maxAttempts: 1,
        },
        onLifecycleEvent: (event) => {
          lifecycleEvents.push(event);
        },
      },
    });

    const subscribePromise = stream.subscribe(() => undefined);
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1000, reason: "done" });
    await subscribePromise;

    expect(
      lifecycleEvents.some(
        (event) =>
          event.type === "reconnect_scheduled" &&
          event.trigger === "connect_failed" &&
          event.attempt === 1
      )
    ).toBe(true);

    expect(lifecycleEvents.at(-1)).toMatchObject({
      type: "stream_ended",
      reason: "graceful",
    });
  });

  it("raises retry_limit when connect retries are exhausted before any socket opens", async () => {
    const lifecycleEvents: TailLifecycleEvent[] = [];

    const { stream, sockets } = buildTailStream({
      websocketFactory: () => {
        throw new Error("factory failed");
      },
      tailOptions: {
        reconnect: true,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
          maxAttempts: 0,
        },
        onLifecycleEvent: (event) => {
          lifecycleEvents.push(event);
        },
      },
    });

    const subscribePromise = stream.subscribe(() => undefined);
    const tailError = (await subscribePromise.catch(
      (error) => error
    )) as StarciteRetryLimitError;

    expect(sockets).toHaveLength(0);
    expect(tailError).toBeInstanceOf(StarciteRetryLimitError);
    expect(tailError.stage).toBe("retry_limit");
    expect(tailError.attempts).toBe(1);
    expect(lifecycleEvents).toEqual([
      {
        type: "connect_attempt",
        sessionId: "ses_tail",
        attempt: 1,
        cursor: 0,
      },
    ]);
  });

  it("raises retry_limit with close metadata after dropped reconnect exhaustion", async () => {
    const { stream, sockets } = buildTailStream({
      tailOptions: {
        reconnect: true,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
          maxAttempts: 0,
        },
      },
    });

    const subscribePromise = stream.subscribe(() => undefined);
    const rejection = subscribePromise.catch((error) => error);
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1006, reason: "network gone" });

    const tailError = (await rejection) as StarciteRetryLimitError;
    expect(tailError).toBeInstanceOf(StarciteRetryLimitError);
    expect(tailError.stage).toBe("retry_limit");
    expect(tailError.attempts).toBe(1);
    expect(tailError.closeCode).toBe(1006);
    expect(tailError.closeReason).toBe("network gone");
  });

  it("propagates consumer handler failures and stops the stream", async () => {
    const { stream, sockets } = buildTailStream({
      tailOptions: {
        reconnect: false,
      },
    });

    const subscribePromise = stream.subscribe(() => {
      throw new Error("consumer crashed");
    });
    const rejection = subscribePromise.catch((error) => error);
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "frame 1" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 1,
      }),
    });

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("consumer crashed");
  });
});
