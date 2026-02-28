import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedWebSocket } from "../src/tail/managed-websocket";
import type {
  StarciteWebSocket,
  StarciteWebSocketEventMap,
} from "../src/types";

class FakeWebSocket implements StarciteWebSocket {
  readonly url: string;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

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

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
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

function buildManaged(
  options: {
    url?: () => string | Promise<string>;
    websocketFactory?: (url: string) => StarciteWebSocket;
    signal?: AbortSignal;
    shouldReconnect?: boolean;
    reconnectPolicy?: {
      initialDelayMs?: number;
      maxDelayMs?: number;
      multiplier?: number;
      jitterRatio?: number;
      maxAttempts?: number;
    };
    connectionTimeoutMs?: number;
    inactivityTimeoutMs?: number;
  } = {}
) {
  const sockets: FakeWebSocket[] = [];
  const manager = new ManagedWebSocket({
    url: options.url ?? (() => "ws://localhost:4000/v1/sessions/ses_1/tail"),
    websocketFactory:
      options.websocketFactory ??
      ((url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      }),
    signal: options.signal,
    shouldReconnect: options.shouldReconnect ?? false,
    reconnectPolicy: {
      initialDelayMs: options.reconnectPolicy?.initialDelayMs ?? 0,
      maxDelayMs: options.reconnectPolicy?.maxDelayMs ?? 0,
      multiplier: options.reconnectPolicy?.multiplier ?? 1,
      jitterRatio: options.reconnectPolicy?.jitterRatio ?? 0,
      maxAttempts: options.reconnectPolicy?.maxAttempts ?? 2,
    },
    connectionTimeoutMs: options.connectionTimeoutMs ?? 1000,
    inactivityTimeoutMs: options.inactivityTimeoutMs,
  });

  return { manager, sockets };
}

describe("ManagedWebSocket", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits connect_failed and retry_limit when URL resolution fails", async () => {
    const connectAttempts: number[] = [];
    const connectFailures: string[] = [];
    const retryLimitEvents: Array<{ trigger: string; rootCause?: string }> = [];

    const { manager, sockets } = buildManaged({
      url: () => {
        throw new Error("resolver exploded");
      },
      shouldReconnect: true,
      reconnectPolicy: { maxAttempts: 0 },
    });

    manager.onConnectAttempt((event) => {
      connectAttempts.push(event.attempt);
    });
    manager.onConnectFailed((event) => {
      connectFailures.push(event.rootCause);
    });
    manager.onRetryLimit((event) => {
      retryLimitEvents.push({
        trigger: event.trigger,
        rootCause: event.rootCause,
      });
    });

    await manager.waitForClose();

    expect(sockets).toHaveLength(0);
    expect(connectAttempts).toEqual([1]);
    expect(connectFailures).toEqual(["resolver exploded"]);
    expect(retryLimitEvents).toEqual([
      {
        trigger: "connect_failed",
        rootCause: "resolver exploded",
      },
    ]);
  });

  it("reconnects after dropped closes and preserves drop metadata", async () => {
    const connectAttempts: number[] = [];
    const droppedEvents: Array<{ code?: number; reason?: string }> = [];
    const scheduledEvents: Array<{ attempt: number; trigger: string }> = [];
    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const { manager, sockets } = buildManaged({
      shouldReconnect: true,
      reconnectPolicy: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        multiplier: 1,
        jitterRatio: 0,
        maxAttempts: 2,
      },
    });

    manager.onConnectAttempt((event) => {
      connectAttempts.push(event.attempt);
    });
    manager.onDropped((event) => {
      droppedEvents.push({ code: event.closeCode, reason: event.closeReason });
    });
    manager.onReconnectScheduled((event) => {
      scheduledEvents.push({ attempt: event.attempt, trigger: event.trigger });
    });
    manager.onClosed((event) => {
      closedEvent = event;
    });

    const done = manager.waitForClose();

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("close", { code: 1006, reason: "upstream reset" });

    await waitForSocketCount(sockets, 2);
    sockets[1]?.emit("close", { code: 1000, reason: "finished" });

    await done;

    expect(connectAttempts).toEqual([1, 2]);
    expect(droppedEvents).toEqual([{ code: 1006, reason: "upstream reset" }]);
    expect(scheduledEvents).toEqual([{ attempt: 1, trigger: "dropped" }]);
    expect(closedEvent).toMatchObject({
      closeCode: 1000,
      closeReason: "finished",
      aborted: false,
      graceful: true,
    });
  });

  it("retries connect_failed errors and recovers on a later attempt", async () => {
    const connectAttempts: number[] = [];
    const connectFailures: string[] = [];
    const reconnectEvents: Array<{ attempt: number; trigger: string }> = [];
    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const sockets: FakeWebSocket[] = [];
    let shouldFail = true;
    const { manager } = buildManaged({
      shouldReconnect: true,
      reconnectPolicy: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        multiplier: 1,
        jitterRatio: 0,
        maxAttempts: 2,
      },
      websocketFactory: (url) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("dial failed");
        }

        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    manager.onConnectAttempt((event) => {
      connectAttempts.push(event.attempt);
    });
    manager.onConnectFailed((event) => {
      connectFailures.push(event.rootCause);
    });
    manager.onReconnectScheduled((event) => {
      reconnectEvents.push({ attempt: event.attempt, trigger: event.trigger });
    });
    manager.onClosed((event) => {
      closedEvent = event;
    });

    const done = manager.waitForClose();
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1000, reason: "recovered" });
    await done;

    expect(connectAttempts).toEqual([1, 2]);
    expect(connectFailures).toEqual(["dial failed"]);
    expect(reconnectEvents).toEqual([
      { attempt: 1, trigger: "connect_failed" },
    ]);
    expect(closedEvent).toMatchObject({
      closeCode: 1000,
      closeReason: "recovered",
      graceful: true,
    });
  });

  it("emits retry_limit with dropped close metadata", async () => {
    const retryLimitEvents: Array<{
      trigger: string;
      closeCode?: number;
      closeReason?: string;
    }> = [];

    const { manager, sockets } = buildManaged({
      shouldReconnect: true,
      reconnectPolicy: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        multiplier: 1,
        jitterRatio: 0,
        maxAttempts: 0,
      },
    });

    manager.onRetryLimit((event) => {
      retryLimitEvents.push({
        trigger: event.trigger,
        closeCode: event.closeCode,
        closeReason: event.closeReason,
      });
    });

    const done = manager.waitForClose();
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1006, reason: "network gone" });
    await done;

    expect(retryLimitEvents).toEqual([
      {
        trigger: "dropped",
        closeCode: 1006,
        closeReason: "network gone",
      },
    ]);
  });

  it("treats close=1000 as dropped when a transport error was observed", async () => {
    const droppedEvents: Array<{ code?: number; reason?: string }> = [];
    const retryLimitEvents: Array<{ trigger: string; closeCode?: number }> = [];
    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const { manager, sockets } = buildManaged({
      shouldReconnect: true,
      reconnectPolicy: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        multiplier: 1,
        jitterRatio: 0,
        maxAttempts: 0,
      },
    });

    manager.onDropped((event) => {
      droppedEvents.push({ code: event.closeCode, reason: event.closeReason });
    });
    manager.onRetryLimit((event) => {
      retryLimitEvents.push({
        trigger: event.trigger,
        closeCode: event.closeCode,
      });
    });
    manager.onClosed((event) => {
      closedEvent = event;
    });

    const done = manager.waitForClose();
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("error", undefined);
    sockets[0]?.emit("close", { code: 1000, reason: "normal close" });
    await done;

    expect(droppedEvents).toEqual([{ code: 1000, reason: "normal close" }]);
    expect(retryLimitEvents).toEqual([{ trigger: "dropped", closeCode: 1000 }]);
    expect(closedEvent?.graceful).toBe(false);
  });

  it("fails with connection timeout when websocket never opens", async () => {
    vi.useFakeTimers();

    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const { manager, sockets } = buildManaged({
      shouldReconnect: false,
      connectionTimeoutMs: 25,
    });

    manager.onClosed((event) => {
      closedEvent = event;
    });

    const done = manager.waitForClose();

    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(26);
    await done;

    expect(closedEvent).toMatchObject({
      closeCode: 4100,
      closeReason: "connection timeout",
      aborted: false,
      graceful: false,
    });
  });

  it("fails with inactivity timeout and resets inactivity watchdog on messages", async () => {
    vi.useFakeTimers();

    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const { manager, sockets } = buildManaged({
      shouldReconnect: false,
      connectionTimeoutMs: 1000,
      inactivityTimeoutMs: 20,
    });

    manager.onClosed((event) => {
      closedEvent = event;
    });

    const done = manager.waitForClose();

    expect(sockets).toHaveLength(1);
    sockets[0]?.emit("open", undefined);

    await vi.advanceTimersByTimeAsync(15);
    sockets[0]?.emit("message", { data: "frame-1" });

    await vi.advanceTimersByTimeAsync(15);
    expect(closedEvent).toBeUndefined();

    await vi.advanceTimersByTimeAsync(6);
    await done;

    expect(closedEvent).toMatchObject({
      closeCode: 4000,
      closeReason: "inactivity timeout",
      aborted: false,
      graceful: false,
    });
  });

  it("marks stream as aborted when the provided signal is aborted", async () => {
    const controller = new AbortController();
    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const { manager, sockets } = buildManaged({
      signal: controller.signal,
      shouldReconnect: true,
    });

    manager.onClosed((event) => {
      closedEvent = event;
    });

    const done = manager.waitForClose();
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("open", undefined);
    controller.abort();
    await done;

    expect(closedEvent).toMatchObject({
      closeCode: 1000,
      closeReason: "aborted",
      aborted: true,
      graceful: true,
    });
  });

  it("forwards explicit close() code/reason to the active socket", async () => {
    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const { manager, sockets } = buildManaged({ shouldReconnect: false });
    manager.onClosed((event) => {
      closedEvent = event;
    });

    const done = manager.waitForClose();
    await waitForSocketCount(sockets, 1);

    manager.close(4321, "manual shutdown");
    await done;

    expect(sockets[0]?.closeCalls).toContainEqual({
      code: 4321,
      reason: "manual shutdown",
    });
    expect(closedEvent).toMatchObject({
      closeCode: 4321,
      closeReason: "manual shutdown",
      graceful: false,
      aborted: false,
    });
  });

  it("emits fatal and closes when connect_attempt listeners throw", async () => {
    const fatalMessages: string[] = [];

    const { manager, sockets } = buildManaged();

    manager.onFatal((error) => {
      fatalMessages.push(
        error instanceof Error ? error.message : String(error)
      );
    });
    manager.onConnectAttempt(() => {
      throw new Error("attempt observer failed");
    });

    await manager.waitForClose();

    expect(sockets).toHaveLength(0);
    expect(fatalMessages).toContain("attempt observer failed");
  });

  it("emits fatal and closes when message listeners throw", async () => {
    const fatalMessages: string[] = [];
    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const { manager, sockets } = buildManaged({ shouldReconnect: false });

    manager.onMessage(() => {
      throw new Error("message observer failed");
    });
    manager.onFatal((error) => {
      fatalMessages.push(
        error instanceof Error ? error.message : String(error)
      );
    });
    manager.onClosed((event) => {
      closedEvent = event;
    });

    const done = manager.waitForClose();
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("open", undefined);
    sockets[0]?.emit("message", { data: { ok: true } });

    await done;

    expect(fatalMessages).toContain("message observer failed");
    expect(fatalMessages).toContain(
      "Managed websocket message listener failed"
    );
    expect(closedEvent).toMatchObject({
      closeCode: 1000,
      closeReason: "listener failed",
      graceful: true,
    });
  });

  it("emits fatal when reconnect_scheduled listeners throw", async () => {
    const fatalMessages: string[] = [];

    const { manager, sockets } = buildManaged({
      shouldReconnect: true,
      reconnectPolicy: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        multiplier: 1,
        jitterRatio: 0,
        maxAttempts: 2,
      },
    });

    manager.onFatal((error) => {
      fatalMessages.push(
        error instanceof Error ? error.message : String(error)
      );
    });
    manager.onReconnectScheduled(() => {
      throw new Error("reconnect observer failed");
    });

    const done = manager.waitForClose();
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1006, reason: "drop" });
    await done;

    expect(fatalMessages).toContain("reconnect observer failed");
    expect(sockets).toHaveLength(1);
  });

  it("can be closed before start and still resolves cleanly", async () => {
    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const { manager, sockets } = buildManaged();

    manager.onClosed((event) => {
      closedEvent = event;
    });

    manager.close(1000, "manual close");
    await manager.waitForClose();

    expect(sockets).toHaveLength(0);
    expect(closedEvent).toMatchObject({
      closeCode: 1000,
      closeReason: "manual close",
      aborted: false,
      graceful: true,
    });
  });

  it("returns the same waitForClose() promise for repeated callers", async () => {
    const { manager, sockets } = buildManaged();

    const firstWait = manager.waitForClose();
    const secondWait = manager.waitForClose();

    expect(firstWait).toBe(secondWait);
    await waitForSocketCount(sockets, 1);
    manager.close(1000, "done");
    await firstWait;
    expect(sockets).toHaveLength(1);
  });

  it("stops pending reconnect timers when close() is called during backoff", async () => {
    vi.useFakeTimers();

    let closedEvent:
      | {
          closeCode?: number;
          closeReason?: string;
          aborted: boolean;
          graceful: boolean;
        }
      | undefined;

    const { manager, sockets } = buildManaged({
      shouldReconnect: true,
      reconnectPolicy: {
        initialDelayMs: 100,
        maxDelayMs: 100,
        multiplier: 1,
        jitterRatio: 0,
        maxAttempts: 3,
      },
    });

    manager.onClosed((event) => {
      closedEvent = event;
    });

    const done = manager.waitForClose();
    expect(sockets).toHaveLength(1);

    sockets[0]?.emit("close", { code: 1006, reason: "dropped" });
    manager.close(1000, "manual stop");

    await vi.advanceTimersByTimeAsync(200);
    await done;

    expect(sockets).toHaveLength(1);
    expect(closedEvent).toMatchObject({
      closeCode: 1006,
      closeReason: "dropped",
      graceful: false,
      aborted: false,
    });
  });
});
