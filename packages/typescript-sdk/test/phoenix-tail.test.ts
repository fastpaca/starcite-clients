import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Starcite } from "../src/client";
import { StarciteTailError, StarciteTokenExpiredError } from "../src/errors";
import { MemoryStore } from "../src/session-store";

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

  it("subscribes to lifecycle over Phoenix and emits session.created", async () => {
    const client = new Starcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    });

    const seen: string[] = [];
    const stop = client.on("session.created", (event) => {
      seen.push(event.session_id);
    });

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    expect(socket?.endPoint).toBe("ws://localhost:4000/v1/socket");
    expect(socket?.currentParams()).toEqual({
      token: makeApiKey(),
    });

    const channel = await waitForChannel("lifecycle");
    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("lifecycle", {
      event: {
        kind: "session.created",
        session_id: "ses_lifecycle",
        tenant_id: "tenant-alpha",
        title: "Lifecycle Demo",
        metadata: {},
        created_at: "2026-03-27T12:00:00Z",
      },
    });
    await flush();

    expect(seen).toEqual(["ses_lifecycle"]);

    stop();
    await flush();
    expect(channel.leaveCalls).toBe(1);
    expect(socket?.disconnectCalls).toHaveLength(1);
  });

  it("ignores unsupported lifecycle event kinds without surfacing an error", async () => {
    const client = new Starcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    });

    const seen: string[] = [];
    const errors: Error[] = [];
    const stopCreated = client.on("session.created", (event) => {
      seen.push(event.session_id);
    });
    const stopError = client.on("error", (error) => {
      errors.push(error);
    });

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("lifecycle");
    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("lifecycle", {
      event: {
        kind: "session.archived",
        session_id: "ses_archived",
      },
    });
    await flush();

    expect(seen).toEqual([]);
    expect(errors).toEqual([]);

    stopCreated();
    stopError();
  });

  it("uses one Phoenix socket for multiple subscribed sessions and rejoins each topic from its own cursor", async () => {
    const store = new MemoryStore();
    store.save("ses_beta", {
      cursor: { epoch: 1, seq: 6 },
      events: [],
      lastSeq: 6,
    });

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
      store,
    });
    const identity = client.agent({ id: "planner" });
    const alpha = await client.session({ identity, id: "ses_alpha" });
    const beta = await client.session({ identity, id: "ses_beta" });

    const alphaSeen: number[] = [];
    const betaSeen: number[] = [];
    const stopAlpha = alpha.on(
      "event",
      (event) => {
        alphaSeen.push(event.seq);
      },
      { agent: "planner" }
    );
    const stopBeta = beta.on(
      "event",
      (event) => {
        betaSeen.push(event.seq);
      },
      { agent: "planner" }
    );

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    expect(socket?.endPoint).toBe("ws://localhost:4000/v1/socket");
    expect(socket?.currentParams()).toEqual({
      token: makeApiKey(),
    });

    const alphaChannel = await waitForChannel("tail:ses_alpha");
    const betaChannel = await waitForChannel("tail:ses_beta");
    expect(alphaChannel.joinCalls[0]).toEqual({});
    expect(betaChannel.joinCalls[0]).toEqual({
      cursor: { epoch: 1, seq: 6 },
    });

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

    stopAlpha();
    stopBeta();
    alpha.disconnect();
    beta.disconnect();
  });

  it("joins from the stored cursor and replays retained events to late listeners", async () => {
    const store = new MemoryStore();
    store.save("ses_replay", {
      cursor: { epoch: 3, seq: 4 },
      events: [],
      lastSeq: 4,
    });

    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
      store,
    }).session({ token: makeSessionToken("ses_replay") });

    const firstSeen: number[] = [];
    const secondSeen: number[] = [];
    const stopFirst = session.on("event", (event) => {
      firstSeen.push(event.seq);
    });

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_replay");
    expect(channel.joinCalls[0]).toEqual({
      cursor: { epoch: 3, seq: 4 },
    });

    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("events", {
      events: [
        makeEvent(5, "agent:planner", { epoch: 3, seq: 5 }),
        makeEvent(6, "agent:planner", { epoch: 3, seq: 6 }),
      ],
    });
    await flush();

    const stopSecond = session.on("event", (event) => {
      secondSeen.push(event.seq);
    });
    await flush();

    expect(firstSeen).toEqual([5, 6]);
    expect(secondSeen).toEqual([5, 6]);

    stopFirst();
    stopSecond();
    session.disconnect();
  });

  it("filters event listeners by agent without creating extra channels", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_filter") });

    const plannerSeen: number[] = [];
    const drafterSeen: number[] = [];
    const stopPlanner = session.on(
      "event",
      (event) => {
        plannerSeen.push(event.seq);
      },
      { agent: "planner" }
    );
    const stopDrafter = session.on(
      "event",
      (event) => {
        drafterSeen.push(event.seq);
      },
      { agent: "drafter" }
    );

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_filter");
    expect(phoenixMock.MockPhoenixChannel.instances).toHaveLength(1);

    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("events", {
      events: [
        makeEvent(1, "agent:planner", { epoch: 1, seq: 1 }),
        makeEvent(2, "agent:drafter", { epoch: 1, seq: 2 }),
        makeEvent(3, "agent:planner", { epoch: 1, seq: 3 }),
      ],
    });
    await flush();

    expect(plannerSeen).toEqual([1, 3]);
    expect(drafterSeen).toEqual([2]);

    stopPlanner();
    stopDrafter();
    session.disconnect();
  });

  it("surfaces gap events explicitly and rejoins the channel from next_cursor", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_gap") });

    const gaps: Record<string, unknown>[] = [];
    const stopGap = session.on("gap", (gap) => {
      gaps.push(gap as Record<string, unknown>);
    });
    const stopEvents = session.on("event", () => undefined);

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
      cursor: { epoch: 2, seq: 4 },
    });

    stopGap();
    stopEvents();
    session.disconnect();
  });

  it("surfaces token_expired to session error listeners and detaches the channel", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_expired") });

    const errors: Error[] = [];
    const stopError = session.on("error", (error) => {
      errors.push(error);
    });
    const stopEvents = session.on("event", () => undefined);

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_expired");
    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("token_expired", { reason: "token_expired" });
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(StarciteTokenExpiredError);
    expect(channel.leaveCalls).toBe(1);

    stopError();
    stopEvents();
  });

  it("surfaces join failures to session error listeners", async () => {
    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_join_error") });

    const errors: Error[] = [];
    const stopError = session.on("error", (error) => {
      errors.push(error);
    });
    const stopEvents = session.on("event", () => undefined);

    await waitForSocketCount(1);
    const channel = await waitForChannel("tail:ses_join_error");
    channel.emitJoinError({ reason: "join denied" });
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(StarciteTailError);
    expect(errors[0]?.message).toContain("join denied");

    stopError();
    stopEvents();
  });

  it("cleans up channels per session and disconnects the shared socket when the last handle disconnects", async () => {
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

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const oneChannel = await waitForChannel("tail:ses_one");
    const twoChannel = await waitForChannel("tail:ses_two");

    one.disconnect();
    await flush();
    expect(oneChannel.leaveCalls).toBe(1);
    expect(socket?.disconnectCalls).toHaveLength(0);

    two.disconnect();
    await flush();
    expect(twoChannel.leaveCalls).toBe(1);
    expect(socket?.disconnectCalls).toHaveLength(1);
  });
});
