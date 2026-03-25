import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const phoenixMock = vi.hoisted(() => {
  class MockPush {
    private readonly callbacks = new Map<
      "error" | "ok" | "timeout",
      Array<(payload?: unknown) => void>
    >();

    receive(
      status: "error" | "ok" | "timeout",
      callback: (payload?: unknown) => void
    ): this {
      const handlers = this.callbacks.get(status) ?? [];
      handlers.push(callback);
      this.callbacks.set(status, handlers);
      return this;
    }

    trigger(status: "error" | "ok" | "timeout", payload?: unknown): void {
      const handlers = this.callbacks.get(status) ?? [];
      for (const handler of handlers) {
        handler(payload);
      }
    }
  }

  class MockPhoenixChannel {
    static instances: MockPhoenixChannel[] = [];

    readonly errorCallbacks: Array<(reason?: unknown) => void> = [];
    readonly joinPush = new MockPush();
    readonly joinCalls: Record<string, unknown>[] = [];
    readonly rejoinCalls: Record<string, unknown>[] = [];
    leaveCalls = 0;
    readonly bindings = new Map<
      string,
      Map<number, (payload?: unknown) => void>
    >();
    private refCounter = 0;
    state: "closed" | "errored" | "joined" | "joining" | "leaving" = "closed";
    readonly topic: string;
    private readonly params:
      | Record<string, unknown>
      | (() => Record<string, unknown>);
    private readonly socket: MockPhoenixSocket;

    constructor(
      topic: string,
      params: Record<string, unknown> | (() => Record<string, unknown>),
      socket: MockPhoenixSocket
    ) {
      this.topic = topic;
      this.params = params;
      this.socket = socket;
      MockPhoenixChannel.instances.push(this);
    }

    join(): MockPush {
      this.joinCalls.push(structuredClone(this.resolveParams()));
      this.state = this.socket.connected ? "joined" : "joining";
      return this.joinPush;
    }

    leave(): MockPush {
      this.leaveCalls += 1;
      this.state = "closed";
      this.socket.channels = this.socket.channels.filter((channel) => {
        return channel !== this;
      });
      return new MockPush();
    }

    on(event: string, callback: (payload?: unknown) => void): number {
      this.refCounter += 1;
      const handlers = this.bindings.get(event) ?? new Map();
      handlers.set(this.refCounter, callback);
      this.bindings.set(event, handlers);
      return this.refCounter;
    }

    off(event: string, ref?: number): void {
      const handlers = this.bindings.get(event);
      if (!handlers) {
        return;
      }

      if (ref === undefined) {
        this.bindings.delete(event);
        return;
      }

      handlers.delete(ref);
      if (handlers.size === 0) {
        this.bindings.delete(event);
      }
    }

    onClose(): number {
      return 0;
    }

    onError(callback: (reason?: unknown) => void): number {
      this.errorCallbacks.push(callback);
      return this.errorCallbacks.length;
    }

    emit(event: string, payload?: unknown): void {
      const handlers = this.bindings.get(event);
      if (!handlers) {
        return;
      }

      for (const handler of handlers.values()) {
        handler(payload);
      }
    }

    rejoin(): void {
      this.rejoinCalls.push(structuredClone(this.resolveParams()));
      this.join();
    }

    emitJoinError(payload?: unknown): void {
      this.state = "errored";
      this.joinPush.trigger("error", payload);
    }

    emitJoinOk(payload?: unknown): void {
      this.state = "joined";
      this.joinPush.trigger("ok", payload);
    }

    emitJoinTimeout(): void {
      this.state = "errored";
      this.joinPush.trigger("timeout");
    }

    triggerError(reason?: unknown): void {
      this.state = "errored";
      for (const callback of this.errorCallbacks) {
        callback(reason);
      }
    }

    private resolveParams(): Record<string, unknown> {
      return typeof this.params === "function" ? this.params() : this.params;
    }
  }

  class MockPhoenixSocket {
    static instances: MockPhoenixSocket[] = [];

    static reset(): void {
      MockPhoenixSocket.instances = [];
      MockPhoenixChannel.instances = [];
    }

    channels: MockPhoenixChannel[] = [];
    connected = false;
    connectCalls = 0;
    readonly disconnectCalls: Array<{ code?: number; reason?: string }> = [];
    readonly endPoint: string;
    readonly options: {
      params?: Record<string, unknown> | (() => Record<string, unknown>);
      reconnectAfterMs?: (tries: number) => number;
      rejoinAfterMs?: (tries: number) => number;
    };
    private readonly closeCallbacks = new Map<
      string,
      (event: { code?: number; reason?: string }) => void
    >();
    private readonly errorCallbacks = new Map<
      string,
      (
        error: unknown,
        transport: new (endpoint: string) => object,
        establishedConnections: number
      ) => void
    >();
    private readonly openCallbacks = new Map<string, () => void>();
    private refCounter = 0;

    constructor(
      endPoint: string,
      options: {
        params?: Record<string, unknown> | (() => Record<string, unknown>);
        reconnectAfterMs?: (tries: number) => number;
        rejoinAfterMs?: (tries: number) => number;
      } = {}
    ) {
      this.endPoint = endPoint;
      this.options = options;
      MockPhoenixSocket.instances.push(this);
    }

    channel(
      topic: string,
      params: Record<string, unknown> | (() => Record<string, unknown>) = {}
    ): MockPhoenixChannel {
      const channel = new MockPhoenixChannel(topic, params, this);
      this.channels.push(channel);
      return channel;
    }

    connect(): void {
      this.connectCalls += 1;
    }

    disconnect(callback?: () => void, code?: number, reason?: string): void {
      this.connected = false;
      this.disconnectCalls.push({ code, reason });
      callback?.();
    }

    isConnected(): boolean {
      return this.connected;
    }

    onOpen(callback: () => void): string {
      const ref = this.makeRef();
      this.openCallbacks.set(ref, callback);
      return ref;
    }

    onClose(
      callback: (event: { code?: number; reason?: string }) => void
    ): string {
      const ref = this.makeRef();
      this.closeCallbacks.set(ref, callback);
      return ref;
    }

    onError(
      callback: (
        error: unknown,
        transport: new (endpoint: string) => object,
        establishedConnections: number
      ) => void
    ): string {
      const ref = this.makeRef();
      this.errorCallbacks.set(ref, callback);
      return ref;
    }

    off(refs: string[]): void {
      for (const ref of refs) {
        this.openCallbacks.delete(ref);
        this.closeCallbacks.delete(ref);
        this.errorCallbacks.delete(ref);
      }
    }

    emitOpen(): void {
      this.connected = true;
      for (const callback of this.openCallbacks.values()) {
        callback();
      }
      for (const channel of this.channels) {
        if (channel.state === "errored") {
          channel.rejoin();
        }
      }
    }

    emitClose(event: { code?: number; reason?: string }): void {
      this.connected = false;
      for (const channel of this.channels) {
        if (channel.state !== "closed") {
          channel.state = "errored";
        }
      }
      for (const callback of this.closeCallbacks.values()) {
        callback(event);
      }
    }

    emitError(error: unknown, establishedConnections = 0): void {
      for (const callback of this.errorCallbacks.values()) {
        callback(error, class MockTransport {}, establishedConnections);
      }
    }

    currentParams(): Record<string, unknown> {
      const params = this.options.params;
      if (!params) {
        return {};
      }

      return typeof params === "function" ? params() : params;
    }

    reconnectDelay(tries: number): number | undefined {
      return this.options.reconnectAfterMs?.(tries);
    }

    private makeRef(): string {
      this.refCounter += 1;
      return `${this.refCounter}`;
    }
  }

  return { MockPhoenixChannel, MockPhoenixSocket };
});

vi.mock("phoenix", () => {
  return {
    Channel: phoenixMock.MockPhoenixChannel,
    Socket: phoenixMock.MockPhoenixSocket,
  };
});

import { Starcite } from "../src/client";
import {
  StarciteError,
  StarciteRetryLimitError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "../src/errors";
import type { TailLifecycleEvent } from "../src/types";

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function tokenFromClaims(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url"
  );
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

function makeApiKey(): string {
  return tokenFromClaims({
    iss: "https://starcite.ai",
    tenant_id: "tenant-alpha",
    principal_id: "system",
    principal_type: "agent",
  });
}

function makeSessionToken(sessionId: string, principalId = "planner"): string {
  return tokenFromClaims({
    session_id: sessionId,
    tenant_id: "tenant-alpha",
    principal_id: principalId,
    principal_type: "agent",
  });
}

function makeEvent(
  seq: number,
  actor = "agent:planner",
  cursor?: {
    epoch: number;
    seq: number;
  }
) {
  return {
    actor,
    cursor,
    payload: { text: `event-${seq}` },
    producer_id: `producer:${seq}`,
    producer_seq: seq,
    seq,
    type: "content",
  };
}

function makeSessionRecord(sessionId: string) {
  return new Response(
    JSON.stringify({
      id: sessionId,
      title: null,
      metadata: {},
      last_seq: 0,
      created_at: "2026-03-24T00:00:00Z",
      updated_at: "2026-03-24T00:00:00Z",
    }),
    { status: 201 }
  );
}

function makeTokenResponse(sessionId: string) {
  return new Response(
    JSON.stringify({
      token: makeSessionToken(sessionId),
      expires_in: 3600,
    }),
    { status: 200 }
  );
}

async function waitForSocketCount(expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (phoenixMock.MockPhoenixSocket.instances.length >= expectedCount) {
      return;
    }
    await flush();
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} socket(s); saw ${phoenixMock.MockPhoenixSocket.instances.length}`
  );
}

async function waitForChannel(
  topic: string
): Promise<InstanceType<typeof phoenixMock.MockPhoenixChannel>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const channel = phoenixMock.MockPhoenixChannel.instances.find(
      (candidate) => {
        return candidate.topic === topic;
      }
    );
    if (channel) {
      return channel;
    }
    await flush();
  }

  throw new Error(`Timed out waiting for channel ${topic}`);
}

describe("Phoenix Tail Transport", () => {
  beforeEach(() => {
    phoenixMock.MockPhoenixSocket.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses one Phoenix socket for multiple tailed sessions and rejoins each topic from its own cursor", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeSessionRecord("ses_alpha"))
      .mockResolvedValueOnce(makeTokenResponse("ses_alpha"))
      .mockResolvedValueOnce(makeSessionRecord("ses_beta"))
      .mockResolvedValueOnce(makeTokenResponse("ses_beta"));

    const client = new Starcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const identity = client.agent({ id: "planner" });
    const alpha = await client.session({ identity, id: "ses_alpha" });
    const beta = await client.session({ identity, id: "ses_beta" });

    const alphaSeen: number[] = [];
    const betaSeen: number[] = [];
    const alphaController = new AbortController();
    const betaController = new AbortController();

    const alphaTail = (async () => {
      for await (const { event } of alpha.tail({
        agent: "planner",
        reconnectPolicy: { initialDelayMs: 1, mode: "fixed" },
        signal: alphaController.signal,
      })) {
        alphaSeen.push(event.seq);
      }
    })();
    const betaTail = (async () => {
      for await (const { event } of beta.tail({
        agent: "planner",
        reconnectPolicy: { initialDelayMs: 1, mode: "fixed" },
        signal: betaController.signal,
      })) {
        betaSeen.push(event.seq);
      }
    })();

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    expect(socket?.endPoint).toBe("ws://localhost:4000/v1/socket");
    expect(socket?.currentParams()).toEqual({
      token: makeApiKey(),
    });

    const alphaChannel = await waitForChannel("tail:ses_alpha");
    const betaChannel = await waitForChannel("tail:ses_beta");
    expect(alphaChannel.joinCalls[0]).toEqual({});
    expect(betaChannel.joinCalls[0]).toEqual({});

    socket?.emitOpen();
    alphaChannel.emitJoinOk({});
    betaChannel.emitJoinOk({});
    alphaChannel.emit("events", {
      events: [makeEvent(1, "agent:planner", { epoch: 1, seq: 1 })],
    });
    betaChannel.emit("events", {
      events: [makeEvent(7, "agent:planner", { epoch: 1, seq: 7 })],
    });
    await flush();

    expect(alphaSeen).toEqual([1]);
    expect(betaSeen).toEqual([7]);

    socket?.emitClose({ code: 1006, reason: "network reset" });
    socket?.reconnectDelay(1);
    socket?.emitOpen();
    alphaChannel.emitJoinOk({});
    betaChannel.emitJoinOk({});

    expect(alphaChannel.rejoinCalls.at(-1)).toEqual({
      cursor: { epoch: 1, seq: 1 },
    });
    expect(betaChannel.rejoinCalls.at(-1)).toEqual({
      cursor: { epoch: 1, seq: 7 },
    });

    alphaChannel.emit("events", {
      events: [makeEvent(2, "agent:planner", { epoch: 1, seq: 2 })],
    });
    betaChannel.emit("events", {
      events: [makeEvent(8, "agent:planner", { epoch: 1, seq: 8 })],
    });
    await flush();

    expect(alphaSeen).toEqual([1, 2]);
    expect(betaSeen).toEqual([7, 8]);

    alphaController.abort();
    betaController.abort();
    await Promise.all([alphaTail, betaTail]);
  });

  it("starts replay from the provided object cursor and keeps live delivery fan-out one event at a time", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_cursor") });

    const tail = Array.fromAsync(
      session.tail({
        cursor: { epoch: 1, seq: 0 },
        follow: false,
        catchUpIdleMs: 10,
      })
    );

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_cursor");
    expect(channel.joinCalls[0]).toEqual({
      cursor: { epoch: 1, seq: 0 },
    });
    socket?.emitOpen();
    channel.emitJoinOk({});

    channel.emit("events", {
      events: [
        makeEvent(1, "agent:planner", { epoch: 1, seq: 1 }),
        makeEvent(2, "agent:planner", { epoch: 1, seq: 2 }),
      ],
    });
    await flush();

    const replay = await tail;

    expect(replay.map(({ event }) => event.seq)).toEqual([1, 2]);

    session.disconnect();
  });

  it("replays buffered events to late subscribers on the same shared session channel", async () => {
    const client = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    });
    const token = makeSessionToken("ses_shared");
    const first = client.session({ token });
    const second = client.session({ token });

    const firstSeen: number[] = [];
    const secondSeen: number[] = [];

    const stopFirst = first.on("event", (event) => {
      firstSeen.push(event.seq);
    });

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_shared");
    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("events", {
      events: [
        makeEvent(1, "agent:planner", { epoch: 1, seq: 1 }),
        makeEvent(2, "agent:planner", { epoch: 1, seq: 2 }),
      ],
    });
    await flush();

    const stopSecond = second.on("event", (event) => {
      secondSeen.push(event.seq);
    });
    await flush();

    expect(phoenixMock.MockPhoenixChannel.instances).toHaveLength(1);
    expect(firstSeen).toEqual([1, 2]);
    expect(secondSeen).toEqual([1, 2]);

    stopFirst();
    stopSecond();
    first.disconnect();
    second.disconnect();
  });

  it("fails fast if a legacy websocketFactory is provided for Phoenix tailing", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
      websocketFactory: () => {
        throw new Error("should not be used");
      },
    }).session({ token: makeSessionToken("ses_legacy_factory") });

    await expect(Array.fromAsync(session.tail())).rejects.toBeInstanceOf(
      StarciteError
    );
    await expect(Array.fromAsync(session.tail())).rejects.toThrow(
      "websocketFactory is not supported"
    );
    expect(phoenixMock.MockPhoenixSocket.instances).toHaveLength(0);
  });

  it("rejects invalid batch sizes at the SDK boundary", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_bad_batch_size") });

    await expect(
      Array.fromAsync(
        session.tail({
          batchSize: 1001,
        })
      )
    ).rejects.toThrow("batchSize must be an integer between 1 and 1000");
    expect(phoenixMock.MockPhoenixSocket.instances).toHaveLength(0);
  });

  it("surfaces gap events explicitly and rejoins the channel", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_gap") });

    const gaps: TailGapLike[] = [];
    const stop = session.on("gap", (gap) => {
      gaps.push(gap as TailGapLike);
    });

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_gap");
    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("events", {
      events: [makeEvent(1, "agent:planner", { epoch: 1, seq: 1 })],
    });
    channel.emit("gap", {
      committed_cursor: { epoch: 2, seq: 4 },
      earliest_available_cursor: { epoch: 2, seq: 4 },
      from_cursor: { epoch: 1, seq: 1 },
      next_cursor: { epoch: 2, seq: 4 },
      reason: "rollback",
      type: "gap",
    });
    await flush();

    expect(gaps).toEqual([
      {
        committed_cursor: { epoch: 2, seq: 4 },
        earliest_available_cursor: { epoch: 2, seq: 4 },
        from_cursor: { epoch: 1, seq: 1 },
        next_cursor: { epoch: 2, seq: 4 },
        reason: "rollback",
        type: "gap",
      },
    ]);
    expect(channel.rejoinCalls.at(-1)).toEqual({
      cursor: { epoch: 1, seq: 1 },
    });

    stop();
    session.disconnect();
  });

  it("rejects tail iterators on token_expired", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_expired") });

    const controller = new AbortController();
    const tail = Array.fromAsync(
      session.tail({
        signal: controller.signal,
      })
    );

    await waitForSocketCount(1);
    const channel = await waitForChannel("tail:ses_expired");
    channel.emit("token_expired", { reason: "token_expired" });

    await expect(tail).rejects.toBeInstanceOf(StarciteTokenExpiredError);
  });

  it("maps stalled Phoenix joins to the legacy connection-timeout error", async () => {
    vi.useFakeTimers();

    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_timeout") });

    const tail = Array.fromAsync(
      session.tail({
        connectionTimeoutMs: 20,
        reconnect: false,
      })
    );
    const rejection = tail.catch((failure) => {
      return failure;
    });

    await waitForSocketCount(1);
    await vi.advanceTimersByTimeAsync(21);

    const error = await rejection;
    expect(error).toBeInstanceOf(StarciteTailError);
    expect((error as StarciteTailError).closeCode).toBe(4100);
    expect((error as StarciteTailError).closeReason).toBe("connection timeout");
  });

  it("treats join errors as reconnect failures and enforces retry_limit", async () => {
    const lifecycleEvents: TailLifecycleEvent[] = [];
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_join_error") });

    const tail = Array.fromAsync(
      session.tail({
        reconnect: true,
        reconnectPolicy: {
          initialDelayMs: 0,
          maxAttempts: 0,
          mode: "fixed",
        },
        onLifecycleEvent: (event) => {
          lifecycleEvents.push(event);
        },
      })
    );

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_join_error");
    socket?.emitOpen();
    channel.emitJoinError({ reason: "join denied" });

    const error = await tail.catch((failure) => {
      return failure;
    });
    expect(error).toBeInstanceOf(StarciteRetryLimitError);
    expect(
      lifecycleEvents.some((event) => {
        return (
          event.type === "connect_attempt" &&
          event.attempt === 1 &&
          event.cursor === undefined &&
          event.sessionId === "ses_join_error"
        );
      })
    ).toBe(true);
  });

  it("emits reconnect_scheduled lifecycle events for join timeouts", async () => {
    const lifecycleEvents: TailLifecycleEvent[] = [];
    const controller = new AbortController();
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_join_timeout") });

    const tail = Array.fromAsync(
      session.tail({
        reconnect: true,
        reconnectPolicy: {
          initialDelayMs: 0,
          maxAttempts: 1,
          mode: "fixed",
        },
        onLifecycleEvent: (event) => {
          lifecycleEvents.push(event);
        },
        signal: controller.signal,
      })
    );

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_join_timeout");
    socket?.emitOpen();
    channel.emitJoinTimeout();
    await flush();

    expect(
      lifecycleEvents.some((event) => {
        return (
          event.type === "reconnect_scheduled" &&
          event.attempt === 1 &&
          event.delayMs === 0 &&
          event.sessionId === "ses_join_timeout" &&
          event.trigger === "connect_failed"
        );
      })
    ).toBe(true);

    controller.abort();
    await tail;
  });

  it("retries after transport error followed by close=1000", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_error_then_close") });

    const tail = Array.fromAsync(
      session.tail({
        reconnect: true,
        reconnectPolicy: {
          initialDelayMs: 0,
          maxAttempts: 0,
          mode: "fixed",
        },
      })
    );

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_error_then_close");
    socket?.emitOpen();
    channel.emitJoinOk({});

    socket?.emitError(new Error("transport failed"), 1);
    socket?.emitClose({ code: 1000, reason: "normal close" });

    const error = await tail.catch((failure) => {
      return failure;
    });
    expect(error).toBeInstanceOf(StarciteRetryLimitError);
    expect((error as StarciteRetryLimitError).closeCode).toBe(1000);
    expect((error as StarciteRetryLimitError).closeReason).toBe("normal close");
  });

  it("honors reconnect jitter in the shared Phoenix socket policy", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_jitter") });

    const controller = new AbortController();
    const tail = Array.fromAsync(
      session.tail({
        reconnectPolicy: {
          initialDelayMs: 10,
          jitterRatio: 0.5,
          mode: "fixed",
        },
        signal: controller.signal,
      })
    );

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    expect(socket?.reconnectDelay(1)).toBe(15);

    controller.abort();
    await tail;
    expect(randomSpy).toHaveBeenCalled();
  });

  it("cleans up channels per session and disconnects the shared socket when the last subscription leaves", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeSessionRecord("ses_one"))
      .mockResolvedValueOnce(makeTokenResponse("ses_one"))
      .mockResolvedValueOnce(makeSessionRecord("ses_two"))
      .mockResolvedValueOnce(makeTokenResponse("ses_two"));

    const client = new Starcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const identity = client.agent({ id: "planner" });
    const one = await client.session({ identity, id: "ses_one" });
    const two = await client.session({ identity, id: "ses_two" });

    const stopOne = one.on("event", () => undefined);
    const stopTwo = two.on("event", () => undefined);

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const oneChannel = await waitForChannel("tail:ses_one");
    const twoChannel = await waitForChannel("tail:ses_two");

    stopOne();
    await flush();
    expect(oneChannel.leaveCalls).toBe(1);
    expect(socket?.disconnectCalls).toHaveLength(0);

    stopTwo();
    await flush();
    expect(twoChannel.leaveCalls).toBe(1);
    expect(socket?.disconnectCalls).toHaveLength(1);
  });
});

interface TailGapLike {
  type?: "gap";
  reason?: "cursor_expired" | "epoch_stale" | "rollback";
  from_cursor?: {
    epoch: number;
    seq: number;
  };
  next_cursor?: {
    epoch: number;
    seq: number;
  };
  committed_cursor?: {
    epoch: number;
    seq: number;
  };
  earliest_available_cursor?: {
    epoch: number;
    seq: number;
  };
}
