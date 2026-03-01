import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Starcite } from "../../src/client";
import {
  StarciteRetryLimitError,
  StarciteTokenExpiredError,
} from "../../src/errors";
import type {
  SessionTailOptions,
  StarciteWebSocketCloseEvent,
  StarciteWebSocketEventMap,
  StarciteWebSocketMessageEvent,
  TailEvent,
} from "../../src/types";

const BASE64_URL_PADDING_REGEX = /=+$/;

class FakeBrowserWebSocket {
  static instances: FakeBrowserWebSocket[] = [];
  static reset(): void {
    FakeBrowserWebSocket.instances = [];
  }

  readonly url: string;
  readonly protocolsOrOptions: unknown;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  private readonly listeners = new Map<
    keyof StarciteWebSocketEventMap,
    Set<(event: unknown) => void>
  >();

  constructor(url: string | URL, protocolsOrOptions?: unknown) {
    this.url = String(url);
    this.protocolsOrOptions = protocolsOrOptions;
    FakeBrowserWebSocket.instances.push(this);
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

  emitOpen(): void {
    this.emit("open", undefined);
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data } satisfies StarciteWebSocketMessageEvent);
  }

  emitClose(event: StarciteWebSocketCloseEvent): void {
    this.emit("close", event);
  }

  emitError(): void {
    this.emit("error", undefined);
  }

  private emit<TType extends keyof StarciteWebSocketEventMap>(
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

async function waitForSocketCount(expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (FakeBrowserWebSocket.instances.length >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} socket(s); saw ${FakeBrowserWebSocket.instances.length}`
  );
}

async function waitForCondition(
  predicate: () => boolean,
  failureMessage: string
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(failureMessage);
}

async function waitForValues<T>(
  values: T[],
  expectedCount: number
): Promise<void> {
  await waitForCondition(
    () => values.length >= expectedCount,
    `Timed out waiting for ${expectedCount} value(s); saw ${values.length}`
  );
}

function startTail(
  session: {
    tail: (
      onEvent: (event: TailEvent) => void | Promise<void>,
      options?: SessionTailOptions
    ) => Promise<void>;
  },
  options: SessionTailOptions = {}
): { events: TailEvent[]; done: Promise<void> } {
  const events: TailEvent[] = [];

  return {
    events,
    done: session.tail((event) => {
      events.push(event);
    }, options),
  };
}

function startTailBatches(
  session: {
    tailBatches: (
      onBatch: (batch: TailEvent[]) => void | Promise<void>,
      options?: SessionTailOptions
    ) => Promise<void>;
  },
  options: SessionTailOptions = {}
): { batches: TailEvent[][]; done: Promise<void> } {
  const batches: TailEvent[][] = [];

  return {
    batches,
    done: session.tailBatches((batch) => {
      batches.push(batch);
    }, options),
  };
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(BASE64_URL_PADDING_REGEX, "");
}

function tokenFromClaims(claims: Record<string, unknown>): string {
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

function makeTailSessionToken(
  sessionId = "ses_browser",
  principalId = "agent:planner"
): string {
  return tokenFromClaims({
    session_id: sessionId,
    tenant_id: "browser-tenant",
    principal_id: principalId,
    principal_type: principalId.startsWith("agent:") ? "agent" : "user",
  });
}

describe("Browser Multi-Agent Workflows", () => {
  const originalWebSocket = globalThis.WebSocket;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    FakeBrowserWebSocket.reset();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeBrowserWebSocket,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  it("uses access_token websocket auth by default in browser runtimes", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_access", "agent:planner"),
    });

    const { events, done: tailDone } = startTail(session);
    await waitForSocketCount(1);

    const socket = FakeBrowserWebSocket.instances[0];
    expect(socket?.url).toContain("/sessions/ses_access/tail?");
    expect(socket?.url).toContain("cursor=0");
    expect(socket?.url).toContain("access_token=");
    expect(socket?.protocolsOrOptions).toBeUndefined();

    socket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "planner frame" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 1,
      })
    );

    await waitForValues(events, 1);
    expect(events[0]).toMatchObject({ seq: 1, actor: "agent:planner" });

    socket?.emitClose({ code: 1000, reason: "done" });
    await expect(tailDone).resolves.toBeUndefined();
  });

  it("runs concurrent agent-filtered tails for multi-agent browser workflows", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_multi", "agent:coordinator"),
    });

    const plannerTail = startTail(session, { agent: "planner" });
    const drafterTail = startTail(session, { agent: "drafter" });

    await waitForSocketCount(2);
    const plannerSocket = FakeBrowserWebSocket.instances[0];
    const drafterSocket = FakeBrowserWebSocket.instances[1];

    const mixedFrame = JSON.stringify([
      {
        seq: 1,
        type: "content",
        payload: { text: "planner update" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 1,
      },
      {
        seq: 2,
        type: "content",
        payload: { text: "drafter update" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 1,
      },
    ]);

    plannerSocket?.emitMessage(mixedFrame);
    drafterSocket?.emitMessage(mixedFrame);

    await waitForValues(plannerTail.events, 1);
    await waitForValues(drafterTail.events, 1);
    expect(plannerTail.events[0]).toMatchObject({
      seq: 1,
      actor: "agent:planner",
    });
    expect(drafterTail.events[0]).toMatchObject({
      seq: 2,
      actor: "agent:drafter",
    });

    plannerSocket?.emitClose({ code: 1000, reason: "planner done" });
    drafterSocket?.emitClose({ code: 1000, reason: "drafter done" });
    await expect(plannerTail.done).resolves.toBeUndefined();
    await expect(drafterTail.done).resolves.toBeUndefined();
  });

  it("replays retained events to late browser subscribers without opening extra sockets", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_replay", "agent:planner"),
    });

    const firstListenerSeqs: number[] = [];
    const secondListenerSeqs: number[] = [];
    session.on("event", (event) => {
      firstListenerSeqs.push(event.seq);
    });

    await waitForSocketCount(1);
    const socket = FakeBrowserWebSocket.instances[0];
    socket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "planner replay 1" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 1,
      })
    );
    socket?.emitMessage(
      JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "planner replay 2" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 2,
      })
    );

    await waitForCondition(
      () => firstListenerSeqs.length === 2,
      "Timed out waiting for first subscriber events"
    );

    session.on("event", (event) => {
      secondListenerSeqs.push(event.seq);
    });
    expect(secondListenerSeqs).toEqual([1, 2]);
    expect(FakeBrowserWebSocket.instances).toHaveLength(1);

    socket?.emitMessage(
      JSON.stringify({
        seq: 3,
        type: "content",
        payload: { text: "planner replay 3" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 3,
      })
    );
    await waitForCondition(
      () => firstListenerSeqs.length === 3 && secondListenerSeqs.length === 3,
      "Timed out waiting for replay listeners to receive live event"
    );
    expect(firstListenerSeqs).toEqual([1, 2, 3]);
    expect(secondListenerSeqs).toEqual([1, 2, 3]);

    session.disconnect();
  });

  it("keeps browser live-sync active until the last event listener unsubscribes", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_off", "agent:planner"),
    });

    const unsubscribeFirst = session.on("event", () => undefined);
    const unsubscribeSecond = session.on("event", () => undefined);
    await waitForSocketCount(1);
    const socket = FakeBrowserWebSocket.instances[0];

    unsubscribeFirst();
    expect(socket?.closeCalls).toHaveLength(0);

    unsubscribeSecond();
    await waitForCondition(
      () => (socket?.closeCalls.length ?? 0) > 0,
      "Timed out waiting for socket close after last unsubscribe"
    );
    expect(socket?.closeCalls).toContainEqual({
      code: 1000,
      reason: "aborted",
    });
  });

  it("supports explicit access_token auth with custom browser websocket factories", async () => {
    const connectOptionsSeen: unknown[] = [];
    const sockets: FakeBrowserWebSocket[] = [];
    const sessionToken = makeTailSessionToken(
      "ses_explicit_access_token",
      "agent:planner"
    );
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketAuthTransport: "access_token",
      websocketFactory: (url, options) => {
        const socket = new FakeBrowserWebSocket(url, options);
        connectOptionsSeen.push(options);
        sockets.push(socket);
        return socket;
      },
    });
    const session = starcite.session({ token: sessionToken });

    const { done: tailDone } = startTail(session);
    await waitForCondition(
      () => sockets.length >= 1,
      "Timed out waiting for explicit access_token websocket socket"
    );

    const socket = sockets[0];
    expect(socket?.url).toContain("access_token=");
    expect(connectOptionsSeen[0]).toBeUndefined();

    socket?.emitClose({ code: 1000, reason: "done" });
    await expect(tailDone).resolves.toBeUndefined();
  });

  it("reconnects browser tails and resumes from the latest observed cursor", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_reconnect", "agent:planner"),
    });

    const { events, done: tailDone } = startTail(session, {
      reconnectPolicy: {
        mode: "fixed",
        initialDelayMs: 0,
        maxAttempts: 1,
      },
    });
    await waitForSocketCount(1);
    const firstSocket = FakeBrowserWebSocket.instances[0];

    firstSocket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "first frame" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 1,
      })
    );
    await waitForValues(events, 1);
    expect(events[0]?.seq).toBe(1);

    firstSocket?.emitClose({ code: 1006, reason: "dropped" });
    await waitForSocketCount(2);
    const secondSocket = FakeBrowserWebSocket.instances[1];
    expect(secondSocket?.url).toContain("cursor=1");

    secondSocket?.emitMessage(
      JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "second frame" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 2,
      })
    );
    await waitForValues(events, 2);
    expect(events[1]?.seq).toBe(2);

    secondSocket?.emitClose({ code: 1000, reason: "done" });
    await expect(tailDone).resolves.toBeUndefined();
  });

  it("raises token-expired errors for browser tails on close code 4001", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_expired", "agent:planner"),
    });

    const { done: tailDone } = startTail(session);
    await waitForSocketCount(1);

    const socket = FakeBrowserWebSocket.instances[0];
    socket?.emitClose({ code: 4001, reason: "token_expired" });

    const error = await tailDone.catch((failure) => failure);
    expect(error).toBeInstanceOf(StarciteTokenExpiredError);
    expect((error as StarciteTokenExpiredError).closeCode).toBe(4001);
    expect((error as StarciteTokenExpiredError).closeReason).toBe(
      "token_expired"
    );
    expect((error as StarciteTokenExpiredError).stage).toBe("stream");
  });

  it("raises retry_limit when browser websocket creation fails", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: () => {
        throw new Error("browser dial failed");
      },
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_connect_retry_limit", "agent:planner"),
    });

    const { done: tailDone } = startTail(session, {
      reconnect: true,
      reconnectPolicy: {
        mode: "fixed",
        initialDelayMs: 0,
        maxAttempts: 0,
      },
    });

    const error = await tailDone.catch((failure) => failure);
    expect(error).toBeInstanceOf(StarciteRetryLimitError);
    expect((error as StarciteRetryLimitError).stage).toBe("retry_limit");
    expect((error as StarciteRetryLimitError).attempts).toBe(1);
  });

  it("raises retry_limit with close metadata after browser drop", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_drop_retry_limit", "agent:planner"),
    });

    const { done: tailDone } = startTail(session, {
      reconnect: true,
      reconnectPolicy: {
        mode: "fixed",
        initialDelayMs: 0,
        maxAttempts: 0,
      },
    });

    await waitForSocketCount(1);
    const socket = FakeBrowserWebSocket.instances[0];
    socket?.emitClose({ code: 1006, reason: "network gone" });

    const error = await tailDone.catch((failure) => failure);
    expect(error).toBeInstanceOf(StarciteRetryLimitError);
    expect((error as StarciteRetryLimitError).closeCode).toBe(1006);
    expect((error as StarciteRetryLimitError).closeReason).toBe("network gone");
    expect((error as StarciteRetryLimitError).attempts).toBe(1);
  });

  it("treats close=1000 as dropped after browser transport errors", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_error_then_close", "agent:planner"),
    });

    const { done: tailDone } = startTail(session, {
      reconnect: true,
      reconnectPolicy: {
        mode: "fixed",
        initialDelayMs: 0,
        maxAttempts: 0,
      },
    });

    await waitForSocketCount(1);
    const socket = FakeBrowserWebSocket.instances[0];
    socket?.emitError();
    socket?.emitClose({ code: 1000, reason: "normal close" });

    const error = await tailDone.catch((failure) => failure);
    expect(error).toBeInstanceOf(StarciteRetryLimitError);
    expect((error as StarciteRetryLimitError).closeCode).toBe(1000);
    expect((error as StarciteRetryLimitError).closeReason).toBe("normal close");
  });

  it("propagates browser lifecycle callback failures before connecting", async () => {
    const sockets: FakeBrowserWebSocket[] = [];
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeBrowserWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_lifecycle", "agent:planner"),
    });

    const { done: tailDone } = startTail(session, {
      reconnect: false,
      onLifecycleEvent: () => {
        throw new Error("lifecycle observer failed");
      },
    });

    await expect(tailDone).rejects.toThrow("lifecycle observer failed");
    expect(sockets).toHaveLength(0);
  });

  it("keeps concurrent browser agent tails isolated when one stream reconnects", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_isolated", "agent:coordinator"),
    });

    const plannerTail = startTail(session, {
      agent: "planner",
      reconnectPolicy: {
        mode: "fixed",
        initialDelayMs: 0,
        maxAttempts: 1,
      },
    });
    const drafterTail = startTail(session, {
      agent: "drafter",
      reconnectPolicy: {
        mode: "fixed",
        initialDelayMs: 0,
        maxAttempts: 1,
      },
    });
    await waitForSocketCount(2);

    const plannerSocket = FakeBrowserWebSocket.instances[0];
    const drafterSocket = FakeBrowserWebSocket.instances[1];

    plannerSocket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "planner frame 1" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 1,
      })
    );
    drafterSocket?.emitMessage(
      JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "drafter frame 1" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 1,
      })
    );

    await waitForValues(plannerTail.events, 1);
    await waitForValues(drafterTail.events, 1);
    expect(plannerTail.events[0]).toMatchObject({
      seq: 1,
      actor: "agent:planner",
    });
    expect(drafterTail.events[0]).toMatchObject({
      seq: 2,
      actor: "agent:drafter",
    });

    plannerSocket?.emitClose({ code: 1006, reason: "planner dropped" });
    await waitForSocketCount(3);
    const plannerReconnectSocket = FakeBrowserWebSocket.instances[2];
    expect(plannerReconnectSocket?.url).toContain("cursor=1");

    drafterSocket?.emitMessage(
      JSON.stringify({
        seq: 3,
        type: "content",
        payload: { text: "drafter frame 2" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 2,
      })
    );
    await waitForValues(drafterTail.events, 2);
    expect(drafterTail.events[1]).toMatchObject({
      seq: 3,
      actor: "agent:drafter",
    });

    plannerReconnectSocket?.emitMessage(
      JSON.stringify({
        seq: 4,
        type: "content",
        payload: { text: "planner frame 2" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 2,
      })
    );
    await waitForValues(plannerTail.events, 2);
    expect(plannerTail.events[1]).toMatchObject({
      seq: 4,
      actor: "agent:planner",
    });

    plannerReconnectSocket?.emitClose({ code: 1000, reason: "planner done" });
    await expect(plannerTail.done).resolves.toBeUndefined();

    drafterSocket?.emitClose({ code: 1000, reason: "drafter done" });
    await expect(drafterTail.done).resolves.toBeUndefined();
  });

  it("keeps browser live-sync isolated across concurrent sessions", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const plannerSession = starcite.session({
      token: makeTailSessionToken("ses_live_planner", "agent:planner"),
    });
    const drafterSession = starcite.session({
      token: makeTailSessionToken("ses_live_drafter", "agent:drafter"),
    });

    const plannerSeqs: number[] = [];
    const drafterSeqs: number[] = [];
    plannerSession.on("event", (event) => {
      plannerSeqs.push(event.seq);
    });
    drafterSession.on("event", (event) => {
      drafterSeqs.push(event.seq);
    });

    await waitForSocketCount(2);
    const plannerSocket = FakeBrowserWebSocket.instances.find((socket) =>
      socket.url.includes("/sessions/ses_live_planner/tail?")
    );
    const drafterSocket = FakeBrowserWebSocket.instances.find((socket) =>
      socket.url.includes("/sessions/ses_live_drafter/tail?")
    );
    expect(plannerSocket).toBeDefined();
    expect(drafterSocket).toBeDefined();

    plannerSocket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "planner sync frame 1" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 1,
      })
    );
    drafterSocket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "drafter sync frame 1" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 1,
      })
    );

    await waitForCondition(
      () => plannerSeqs.length === 1 && drafterSeqs.length === 1,
      "Timed out waiting for initial isolated live-sync frames"
    );
    expect(
      plannerSession.getSnapshot().events.map((event) => event.seq)
    ).toEqual([1]);
    expect(
      drafterSession.getSnapshot().events.map((event) => event.seq)
    ).toEqual([1]);

    plannerSession.disconnect();
    await waitForCondition(
      () => (plannerSocket?.closeCalls.length ?? 0) > 0,
      "Timed out waiting for planner socket close on disconnect"
    );
    expect(plannerSocket?.closeCalls).toContainEqual({
      code: 1000,
      reason: "aborted",
    });
    expect(drafterSocket?.closeCalls).toHaveLength(0);

    drafterSocket?.emitMessage(
      JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "drafter sync frame 2" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 2,
      })
    );
    await waitForCondition(
      () => drafterSeqs.length === 2,
      "Timed out waiting for continued drafter live-sync events"
    );
    expect(plannerSeqs).toEqual([1]);
    expect(drafterSeqs).toEqual([1, 2]);

    drafterSession.disconnect();
  });

  it("live-syncs a shared browser session log and self-heals on gaps", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_sync", "agent:planner"),
    });

    const observedSeqs: number[] = [];
    session.on("event", (event) => {
      observedSeqs.push(event.seq);
    });

    await waitForSocketCount(1);
    const firstSocket = FakeBrowserWebSocket.instances[0];

    firstSocket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "first frame" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 1,
      })
    );
    firstSocket?.emitMessage(
      JSON.stringify({
        seq: 3,
        type: "content",
        payload: { text: "gap frame" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 3,
      })
    );

    await waitForSocketCount(2);
    const secondSocket = FakeBrowserWebSocket.instances[1];
    expect(secondSocket?.url).toContain("cursor=1");

    secondSocket?.emitMessage(
      JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "second frame" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 2,
      })
    );
    secondSocket?.emitMessage(
      JSON.stringify({
        seq: 3,
        type: "content",
        payload: { text: "third frame" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 3,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observedSeqs).toEqual([1, 2, 3]);
    expect(session.getSnapshot().events.map((event) => event.seq)).toEqual([
      1, 2, 3,
    ]);

    session.disconnect();
  });

  it("routes live-sync conflicts to browser on('error') listeners", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_error", "agent:planner"),
    });

    const syncErrors: Error[] = [];
    session.on("error", (error) => {
      syncErrors.push(error);
    });
    session.on("event", () => undefined);

    await waitForSocketCount(1);
    const socket = FakeBrowserWebSocket.instances[0];

    socket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "first frame" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 1,
      })
    );
    socket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "conflict frame" },
        actor: "agent:planner",
        producer_id: "producer:other",
        producer_seq: 99,
      })
    );

    await waitForCondition(
      () => syncErrors.length > 0,
      "Timed out waiting for sync error callback"
    );

    expect(syncErrors).toHaveLength(1);
    expect(syncErrors[0]?.message).toContain("Session log conflict for seq 1");
    session.disconnect();
  });

  it("uses websocket header auth with custom factories in browser runtimes", async () => {
    const connectOptionsSeen: unknown[] = [];
    const sockets: FakeBrowserWebSocket[] = [];
    const sessionToken = makeTailSessionToken("ses_header", "agent:planner");
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url, options) => {
        const socket = new FakeBrowserWebSocket(url, options);
        connectOptionsSeen.push(options);
        sockets.push(socket);
        return socket;
      },
    });
    const session = starcite.session({ token: sessionToken });

    const { events, done: tailDone } = startTail(session);
    await waitForCondition(
      () => sockets.length >= 1,
      "Timed out waiting for custom websocket factory call"
    );

    const socket = sockets[0];
    expect(socket?.url).not.toContain("access_token=");

    const firstOptions = connectOptionsSeen[0] as
      | { headers?: HeadersInit }
      | undefined;
    const headers = new Headers(firstOptions?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${sessionToken}`);

    socket?.emitMessage(
      JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "header auth frame" },
        actor: "agent:planner",
        producer_id: "producer:planner",
        producer_seq: 1,
      })
    );
    await waitForValues(events, 1);
    expect(events[0]?.seq).toBe(1);

    socket?.emitClose({ code: 1000, reason: "done" });
    await expect(tailDone).resolves.toBeUndefined();
  });

  it("closes browser live-sync sockets when disconnect() is called", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_disconnect", "agent:planner"),
    });

    session.on("event", () => undefined);
    await waitForSocketCount(1);
    const socket = FakeBrowserWebSocket.instances[0];

    session.disconnect();
    expect(socket?.closeCalls).toContainEqual({
      code: 1000,
      reason: "aborted",
    });
  });

  it("isolates producer sequences per browser agent session when appending", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ seq: 1, last_seq: 1, deduped: false }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ seq: 2, last_seq: 2, deduped: false }), {
          status: 200,
        })
      );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    const plannerSession = starcite.session({
      token: makeTailSessionToken("ses_append", "agent:planner"),
    });
    const drafterSession = starcite.session({
      token: makeTailSessionToken("ses_append", "agent:drafter"),
    });

    await plannerSession.append({ text: "planner says hi" });
    await drafterSession.append({ text: "drafter says hi" });

    const plannerBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")
    ) as { actor?: string; producer_seq?: number };
    const drafterBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")
    ) as { actor?: string; producer_seq?: number };

    expect(plannerBody.actor).toBe("agent:planner");
    expect(drafterBody.actor).toBe("agent:drafter");
    expect(plannerBody.producer_seq).toBe(1);
    expect(drafterBody.producer_seq).toBe(1);
  });

  it("preserves batch framing in browser tailBatches with agent filtering", async () => {
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = starcite.session({
      token: makeTailSessionToken("ses_batches", "agent:coordinator"),
    });

    const { batches, done: tailDone } = startTailBatches(session, {
      agent: "planner",
      batchSize: 2,
    });
    await waitForSocketCount(1);
    const socket = FakeBrowserWebSocket.instances[0];
    expect(socket?.url).toContain("batch_size=2");

    socket?.emitMessage(
      JSON.stringify([
        {
          seq: 1,
          type: "content",
          payload: { text: "planner batch event" },
          actor: "agent:planner",
          producer_id: "producer:planner",
          producer_seq: 1,
        },
        {
          seq: 2,
          type: "content",
          payload: { text: "drafter batch event" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 1,
        },
      ])
    );

    await waitForValues(batches, 1);
    expect(batches[0]).toMatchObject([{ seq: 1, actor: "agent:planner" }]);

    socket?.emitClose({ code: 1000, reason: "done" });
    await expect(tailDone).resolves.toBeUndefined();
  });
});
