import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Starcite } from "../src/client";
import { StarciteTailError, StarciteTokenExpiredError } from "../src/errors";
import { MemoryStore } from "../src/session-store";

function makeStarcite(
  options: ConstructorParameters<typeof Starcite>[0] = {}
): Starcite {
  return new Starcite(options);
}

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
      this.scheduleRejoin();
    }

    emitJoinOk(payload?: unknown): void {
      this.state = "joined";
      this.joinPush.trigger("ok", payload);
    }

    emitJoinTimeout(): void {
      this.state = "errored";
      this.joinPush.trigger("timeout");
      this.scheduleRejoin();
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

    private scheduleRejoin(): void {
      if (!this.socket.connected) {
        return;
      }

      setTimeout(() => {
        if (this.state === "errored" && this.socket.connected) {
          this.rejoin();
        }
      }, 0);
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

const INVALID_FROZEN_PAYLOAD_MESSAGE = /^Invalid session\.frozen payload:/;

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

function makeEvent(seq: number, actor = "agent:planner", cursor?: number) {
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

function makeTokenResponse(sessionId: string, principalId = "planner") {
  return new Response(
    JSON.stringify({
      token: makeSessionToken(sessionId, principalId),
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

async function waitForChannels(
  topic: string,
  expectedCount: number
): Promise<InstanceType<typeof phoenixMock.MockPhoenixChannel>[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const channels = phoenixMock.MockPhoenixChannel.instances.filter(
      (candidate) => {
        return candidate.topic === topic;
      }
    );
    if (channels.length >= expectedCount) {
      return channels.slice(0, expectedCount);
    }
    await flush();
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} channel(s) for topic ${topic}`
  );
}

describe("Phoenix Tail Transport", () => {
  beforeEach(() => {
    phoenixMock.MockPhoenixSocket.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("subscribes to lifecycle over Phoenix and emits raw and typed lifecycle events", async () => {
    const client = makeStarcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    });

    const rawSeen: string[] = [];
    const typedSeen: string[] = [];
    const stopLifecycle = client.on("lifecycle", (event) => {
      rawSeen.push(event.kind);
    });
    const stopCreated = client.on("session.created", (event) => {
      typedSeen.push(event.kind);
    });
    const stopHydrating = client.on("session.hydrating", (event) => {
      typedSeen.push(event.kind);
    });
    const stopActivated = client.on("session.activated", (event) => {
      typedSeen.push(event.kind);
    });
    const stopFreezing = client.on("session.freezing", (event) => {
      typedSeen.push(event.kind);
    });
    const stopFrozen = client.on("session.frozen", (event) => {
      typedSeen.push(event.kind);
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
    channel.emit("lifecycle", {
      event: {
        kind: "session.hydrating",
        session_id: "ses_lifecycle",
        tenant_id: "tenant-alpha",
      },
    });
    channel.emit("lifecycle", {
      event: {
        kind: "session.activated",
        session_id: "ses_lifecycle",
        tenant_id: "tenant-alpha",
      },
    });
    channel.emit("lifecycle", {
      event: {
        kind: "session.freezing",
        session_id: "ses_lifecycle",
        tenant_id: "tenant-alpha",
      },
    });
    channel.emit("lifecycle", {
      event: {
        kind: "session.frozen",
        session_id: "ses_lifecycle",
        tenant_id: "tenant-alpha",
      },
    });
    await flush();

    expect(rawSeen).toEqual([
      "session.created",
      "session.hydrating",
      "session.activated",
      "session.freezing",
      "session.frozen",
    ]);
    expect(typedSeen).toEqual([
      "session.created",
      "session.hydrating",
      "session.activated",
      "session.freezing",
      "session.frozen",
    ]);

    stopLifecycle();
    stopCreated();
    stopHydrating();
    stopActivated();
    stopFreezing();
    stopFrozen();
    await flush();
    expect(channel.leaveCalls).toBe(1);
    expect(socket?.disconnectCalls).toHaveLength(1);
  });

  it("keeps the lifecycle channel attached until the last lifecycle listener is removed", async () => {
    const client = makeStarcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    });

    const stopLifecycle = client.on("lifecycle", () => undefined);
    const stopFrozen = client.on("session.frozen", () => undefined);

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("lifecycle");
    socket?.emitOpen();
    channel.emitJoinOk({});

    stopFrozen();
    await flush();
    expect(channel.leaveCalls).toBe(0);

    stopLifecycle();
    await flush();
    expect(channel.leaveCalls).toBe(1);
  });

  it("forwards unsupported lifecycle event kinds through raw listeners without surfacing an error", async () => {
    const client = makeStarcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    });

    const rawSeen: string[] = [];
    const seen: string[] = [];
    const errors: Error[] = [];
    const stopLifecycle = client.on("lifecycle", (event) => {
      rawSeen.push(event.kind);
    });
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

    expect(rawSeen).toEqual(["session.archived"]);
    expect(seen).toEqual([]);
    expect(errors).toEqual([]);

    stopLifecycle();
    stopCreated();
    stopError();
  });

  it("surfaces invalid supported lifecycle payloads as errors", async () => {
    const client = makeStarcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    });

    const rawSeen: string[] = [];
    const typedSeen: string[] = [];
    const errors: Error[] = [];
    const stopLifecycle = client.on("lifecycle", (event) => {
      rawSeen.push(event.kind);
    });
    const stopFrozen = client.on("session.frozen", (event) => {
      typedSeen.push(event.kind);
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
        kind: "session.frozen",
        session_id: "ses_invalid",
      },
    });
    await flush();

    expect(rawSeen).toEqual(["session.frozen"]);
    expect(typedSeen).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(INVALID_FROZEN_PAYLOAD_MESSAGE);

    stopLifecycle();
    stopFrozen();
    stopError();
  });

  it("retries lifecycle joins after a timeout without surfacing an error", async () => {
    const client = makeStarcite({
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
    channel.emitJoinTimeout();
    await flush();

    expect(errors).toEqual([]);
    expect(channel.rejoinCalls.at(-1)).toEqual({});

    channel.emitJoinOk({});
    channel.emit("lifecycle", {
      event: {
        kind: "session.created",
        session_id: "ses_retry_lifecycle",
        tenant_id: "tenant-alpha",
        title: null,
        metadata: {},
        created_at: "2026-03-27T12:00:00Z",
      },
    });
    await flush();

    expect(seen).toEqual(["ses_retry_lifecycle"]);

    stopCreated();
    stopError();
  });

  it("uses session-scoped Phoenix sockets for identity-backed sessions and rejoins each topic from its own cursor", async () => {
    const store = new MemoryStore();
    store.save("ses_beta", {
      cursor: 6,
      events: [],
      lastSeq: 6,
    });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeSessionRecord("ses_alpha"))
      .mockResolvedValueOnce(makeTokenResponse("ses_alpha"))
      .mockResolvedValueOnce(makeSessionRecord("ses_beta"))
      .mockResolvedValueOnce(makeTokenResponse("ses_beta"));

    const client = makeStarcite({
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

    await waitForSocketCount(2);
    const alphaSocket = phoenixMock.MockPhoenixSocket.instances[0];
    const betaSocket = phoenixMock.MockPhoenixSocket.instances[1];
    expect(alphaSocket?.endPoint).toBe("ws://localhost:4000/v1/socket");
    expect(betaSocket?.endPoint).toBe("ws://localhost:4000/v1/socket");
    expect(alphaSocket?.currentParams()).toEqual({
      token: makeSessionToken("ses_alpha"),
    });
    expect(betaSocket?.currentParams()).toEqual({
      token: makeSessionToken("ses_beta"),
    });

    const alphaChannel = await waitForChannel("tail:ses_alpha");
    const betaChannel = await waitForChannel("tail:ses_beta");
    expect(alphaChannel.joinCalls[0]).toEqual({ cursor: 0 });
    expect(betaChannel.joinCalls[0]).toEqual({ cursor: 6 });

    alphaSocket?.emitOpen();
    betaSocket?.emitOpen();
    alphaChannel.emitJoinOk({});
    betaChannel.emitJoinOk({});
    alphaChannel.emit("events", {
      events: [makeEvent(1, "agent:planner", 1)],
    });
    betaChannel.emit("events", {
      events: [makeEvent(7, "agent:planner", 7)],
    });
    await flush();

    expect(alphaSeen).toEqual([1]);
    expect(betaSeen).toEqual([7]);

    alphaSocket?.emitClose({ code: 1006, reason: "network reset" });
    betaSocket?.emitClose({ code: 1006, reason: "network reset" });
    alphaSocket?.emitOpen();
    betaSocket?.emitOpen();
    alphaChannel.emitJoinOk({});
    betaChannel.emitJoinOk({});

    expect(alphaChannel.rejoinCalls.at(-1)).toEqual({ cursor: 1 });
    expect(betaChannel.rejoinCalls.at(-1)).toEqual({ cursor: 7 });

    alphaChannel.emit("events", {
      events: [makeEvent(2, "agent:planner", 2)],
    });
    betaChannel.emit("events", {
      events: [makeEvent(8, "agent:planner", 8)],
    });
    await flush();

    expect(alphaSeen).toEqual([1, 2]);
    expect(betaSeen).toEqual([7, 8]);

    stopAlpha();
    stopBeta();
    alpha.disconnect();
    beta.disconnect();
  });

  it("keeps same-session identity subscribers isolated so one listener still receives follow-up events after another disconnects", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeSessionRecord("ses_shared"))
      .mockResolvedValueOnce(makeTokenResponse("ses_shared", "planner"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "session_exists",
            message: "Session already exists",
          }),
          { status: 409, statusText: "Conflict" }
        )
      )
      .mockResolvedValueOnce(makeTokenResponse("ses_shared", "reviewer"));

    const client = makeStarcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const planner = await client.session({
      identity: client.agent({ id: "planner" }),
      id: "ses_shared",
    });
    const reviewer = await client.session({
      identity: client.agent({ id: "reviewer" }),
      id: "ses_shared",
    });

    const plannerSeen: number[] = [];
    const reviewerSeen: number[] = [];
    const stopPlanner = planner.on("event", (event) => {
      plannerSeen.push(event.seq);
    });
    const stopReviewer = reviewer.on("event", (event) => {
      reviewerSeen.push(event.seq);
    });

    await waitForSocketCount(2);
    const plannerSocket = phoenixMock.MockPhoenixSocket.instances[0];
    const reviewerSocket = phoenixMock.MockPhoenixSocket.instances[1];
    expect(plannerSocket?.currentParams()).toEqual({
      token: makeSessionToken("ses_shared", "planner"),
    });
    expect(reviewerSocket?.currentParams()).toEqual({
      token: makeSessionToken("ses_shared", "reviewer"),
    });

    const [plannerChannel, reviewerChannel] = await waitForChannels(
      "tail:ses_shared",
      2
    );
    expect(plannerChannel.joinCalls[0]).toEqual({ cursor: 0 });
    expect(reviewerChannel.joinCalls[0]).toEqual({ cursor: 0 });

    plannerSocket?.emitOpen();
    reviewerSocket?.emitOpen();
    plannerChannel.emitJoinOk({});
    reviewerChannel.emitJoinOk({});

    const firstUserEvent = makeEvent(1, "user:alice", 1);
    plannerChannel.emit("events", {
      events: [firstUserEvent],
    });
    reviewerChannel.emit("events", {
      events: [firstUserEvent],
    });
    await flush();

    expect(plannerSeen).toEqual([1]);
    expect(reviewerSeen).toEqual([1]);

    reviewer.disconnect();
    await flush();
    expect(reviewerChannel.leaveCalls).toBe(1);
    expect(reviewerSocket?.disconnectCalls).toHaveLength(1);
    expect(plannerSocket?.disconnectCalls).toHaveLength(0);

    plannerChannel.emit("events", {
      events: [makeEvent(2, "user:alice", 2)],
    });
    await flush();

    expect(plannerSeen).toEqual([1, 2]);

    stopPlanner();
    stopReviewer();
    planner.disconnect();
  });

  it("rejoins same-session identity subscribers independently when only one socket resets", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeSessionRecord("ses_rejoin"))
      .mockResolvedValueOnce(makeTokenResponse("ses_rejoin", "planner"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "session_exists",
            message: "Session already exists",
          }),
          { status: 409, statusText: "Conflict" }
        )
      )
      .mockResolvedValueOnce(makeTokenResponse("ses_rejoin", "reviewer"));

    const client = makeStarcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const planner = await client.session({
      identity: client.agent({ id: "planner" }),
      id: "ses_rejoin",
    });
    const reviewer = await client.session({
      identity: client.agent({ id: "reviewer" }),
      id: "ses_rejoin",
    });

    const plannerSeen: number[] = [];
    const reviewerSeen: number[] = [];
    const stopPlanner = planner.on("event", (event) => {
      plannerSeen.push(event.seq);
    });
    const stopReviewer = reviewer.on("event", (event) => {
      reviewerSeen.push(event.seq);
    });

    await waitForSocketCount(2);
    const plannerSocket = phoenixMock.MockPhoenixSocket.instances[0];
    const reviewerSocket = phoenixMock.MockPhoenixSocket.instances[1];
    const [plannerChannel, reviewerChannel] = await waitForChannels(
      "tail:ses_rejoin",
      2
    );

    plannerSocket?.emitOpen();
    reviewerSocket?.emitOpen();
    plannerChannel.emitJoinOk({});
    reviewerChannel.emitJoinOk({});

    const firstUserEvent = makeEvent(1, "user:alice", 1);
    plannerChannel.emit("events", {
      events: [firstUserEvent],
    });
    reviewerChannel.emit("events", {
      events: [firstUserEvent],
    });
    await flush();

    plannerSocket?.emitClose({ code: 1006, reason: "planner reset" });
    plannerSocket?.emitOpen();
    plannerChannel.emitJoinOk({});

    expect(plannerChannel.rejoinCalls.at(-1)).toEqual({ cursor: 1 });
    expect(reviewerChannel.rejoinCalls).toHaveLength(0);

    plannerChannel.emit("events", {
      events: [makeEvent(2, "user:alice", 2)],
    });
    await flush();

    expect(plannerSeen).toEqual([1, 2]);
    expect(reviewerSeen).toEqual([1]);

    stopPlanner();
    stopReviewer();
    planner.disconnect();
    reviewer.disconnect();
  });

  it("delivers later follow-up user events after a burst of same-session worker traffic", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeSessionRecord("ses_followup"))
      .mockResolvedValueOnce(makeTokenResponse("ses_followup", "coordinator"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "session_exists",
            message: "Session already exists",
          }),
          { status: 409, statusText: "Conflict" }
        )
      )
      .mockResolvedValueOnce(makeTokenResponse("ses_followup", "worker"));

    const client = makeStarcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const coordinator = await client.session({
      identity: client.agent({ id: "coordinator" }),
      id: "ses_followup",
    });
    const worker = await client.session({
      identity: client.agent({ id: "worker" }),
      id: "ses_followup",
    });

    const coordinatorSeen: number[] = [];
    const stopCoordinator = coordinator.on("event", (event) => {
      coordinatorSeen.push(event.seq);
    });

    await waitForSocketCount(2);
    const coordinatorSocket = phoenixMock.MockPhoenixSocket.instances[0];
    const workerSocket = phoenixMock.MockPhoenixSocket.instances[1];
    const [coordinatorChannel, workerChannel] = await waitForChannels(
      "tail:ses_followup",
      2
    );

    coordinatorSocket?.emitOpen();
    workerSocket?.emitOpen();
    coordinatorChannel.emitJoinOk({});
    workerChannel.emitJoinOk({});

    const firstUserEvent = makeEvent(1, "user:alice", 1);
    coordinatorChannel.emit("events", {
      events: [firstUserEvent],
    });
    workerChannel.emit("events", {
      events: [firstUserEvent],
    });
    await flush();

    const workerBurst = [
      makeEvent(2, "agent:worker", 2),
      makeEvent(3, "agent:worker", 3),
      makeEvent(4, "agent:worker", 4),
    ];
    coordinatorChannel.emit("events", {
      events: workerBurst,
    });
    workerChannel.emit("events", {
      events: workerBurst,
    });
    await flush();

    coordinatorChannel.emit("events", {
      events: [makeEvent(5, "user:alice", 5)],
    });
    await flush();

    expect(coordinatorSeen).toEqual([1, 2, 3, 4, 5]);

    stopCoordinator();
    coordinator.disconnect();
    worker.disconnect();
  });

  it("joins from the stored cursor and replays retained events to late listeners", async () => {
    const store = new MemoryStore();
    store.save("ses_replay", {
      cursor: 4,
      events: [],
      lastSeq: 4,
    });

    const session = makeStarcite({
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
    expect(channel.joinCalls[0]).toEqual({ cursor: 4 });

    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("events", {
      events: [
        makeEvent(5, "agent:planner", 5),
        makeEvent(6, "agent:planner", 6),
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

  it("classifies server corrections for retained events as live updates", async () => {
    const store = new MemoryStore();
    store.save("ses_updates", {
      cursor: 6,
      events: [
        makeEvent(5, "agent:planner", 5),
        makeEvent(6, "agent:planner", 6),
      ],
      lastSeq: 6,
    });

    const session = makeStarcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
      store,
    }).session({ token: makeSessionToken("ses_updates") });

    const seen: Array<{ phase: string; seq: number; text: string }> = [];
    const stopEvents = session.on("event", (event, context) => {
      seen.push({
        phase: context.phase,
        seq: event.seq,
        text: `${event.payload.text ?? ""}`,
      });
    });

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_updates");
    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("events", {
      events: [
        {
          ...makeEvent(5, "agent:planner", 5),
          payload: { text: "corrected-event-5" },
        },
      ],
    });
    await flush();

    expect(seen).toEqual([
      { phase: "replay", seq: 5, text: "event-5" },
      { phase: "replay", seq: 6, text: "event-6" },
      { phase: "live", seq: 5, text: "corrected-event-5" },
    ]);

    stopEvents();
    session.disconnect();
  });

  it("filters event listeners by agent without creating extra channels", async () => {
    const session = makeStarcite({
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
        makeEvent(1, "agent:planner", 1),
        makeEvent(2, "agent:drafter", 2),
        makeEvent(3, "agent:planner", 3),
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
    const session = makeStarcite({
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
      events: [makeEvent(1, "agent:planner", 1)],
    });
    channel.emit("gap", {
      committed_cursor: 4,
      earliest_available_cursor: 4,
      from_cursor: 1,
      next_cursor: 4,
      reason: "resume_invalidated",
      type: "gap",
    });
    await flush();

    expect(gaps).toEqual([
      {
        committed_cursor: 4,
        earliest_available_cursor: 4,
        from_cursor: 1,
        next_cursor: 4,
        reason: "resume_invalidated",
        type: "gap",
      },
    ]);
    expect(channel.rejoinCalls.at(-1)).toEqual({ cursor: 4 });

    stopGap();
    stopEvents();
    session.disconnect();
  });

  it("treats server-reported gaps as recoverable when no gap listener is attached", async () => {
    const session = makeStarcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_gap_recoverable") });

    const errors: Error[] = [];
    const seen: number[] = [];
    const stopError = session.on("error", (error) => {
      errors.push(error);
    });
    const stopEvents = session.on("event", (event) => {
      seen.push(event.seq);
    });

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_gap_recoverable");
    socket?.emitOpen();
    channel.emitJoinOk({});
    channel.emit("events", {
      events: [makeEvent(1, "agent:planner", 1)],
    });
    channel.emit("gap", {
      committed_cursor: 4,
      earliest_available_cursor: 4,
      from_cursor: 1,
      next_cursor: 4,
      reason: "resume_invalidated",
      type: "gap",
    });
    channel.emitJoinOk({});
    channel.emit("events", {
      events: [makeEvent(4, "agent:planner", 4)],
    });
    await flush();

    expect(errors).toEqual([]);
    expect(seen).toEqual([1, 4]);
    expect(channel.rejoinCalls.at(-1)).toEqual({ cursor: 4 });

    stopError();
    stopEvents();
    session.disconnect();
  });

  it("reconciles an in-flight append when the committed tail event arrives first", async () => {
    let releaseAppendResponse: (() => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      return new Promise<Response>((resolve) => {
        releaseAppendResponse = () => {
          resolve(
            new Response(
              JSON.stringify({ seq: 1, last_seq: 1, deduped: false }),
              { status: 201 }
            )
          );
        };
      });
    });

    const session = makeStarcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    }).session({ token: makeSessionToken("ses_append_reconcile") });

    const appendPromise = session.append({ text: "hello from queue" });
    await Promise.resolve();

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_append_reconcile");
    socket?.emitOpen();
    channel.emitJoinOk({});

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(requestInit.body as string) as {
      idempotency_key?: string;
      producer_id: string;
      producer_seq: number;
    };

    channel.emit("events", {
      events: [
        {
          ...makeEvent(1, "agent:planner", 1),
          idempotency_key: requestBody.idempotency_key ?? null,
          payload: { text: "hello from queue" },
          producer_id: requestBody.producer_id,
          producer_seq: requestBody.producer_seq,
        },
      ],
    });
    await flush();

    await expect(appendPromise).resolves.toEqual({
      deduped: false,
      seq: 1,
    });
    expect(session.appendState()).toEqual(
      expect.objectContaining({
        pending: [],
        status: "idle",
      })
    );

    releaseAppendResponse?.();
    await flush();
    session.disconnect();
  });

  it("surfaces token_expired to session error listeners and detaches the channel", async () => {
    const session = makeStarcite({
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

  it("refreshes expired session tokens and reconnects from the retained cursor without replaying retained events again", async () => {
    const refreshedToken = makeSessionToken(
      "ses_refresh_tail",
      "planner-refreshed"
    );
    const refreshToken = vi.fn().mockResolvedValue(refreshedToken);
    const session = makeStarcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({
      token: makeSessionToken("ses_refresh_tail"),
      refreshToken,
    });

    const errors: Error[] = [];
    const seen: Array<{ phase: string; seq: number }> = [];
    const stopError = session.on("error", (error) => {
      errors.push(error);
    });
    const stopEvents = session.on("event", (event, context) => {
      seen.push({ phase: context.phase, seq: event.seq });
    });

    await waitForSocketCount(1);
    const initialSocket = phoenixMock.MockPhoenixSocket.instances[0];
    const initialChannel = await waitForChannel("tail:ses_refresh_tail");
    initialSocket?.emitOpen();
    initialChannel.emitJoinOk({});
    initialChannel.emit("events", {
      events: [makeEvent(1, "agent:planner", 1)],
    });
    await flush();

    initialChannel.emit("token_expired", { reason: "token_expired" });
    await waitForSocketCount(2);

    const reboundSocket = phoenixMock.MockPhoenixSocket.instances[1];
    const [, reboundChannel] = await waitForChannels(
      "tail:ses_refresh_tail",
      2
    );
    expect(initialChannel.leaveCalls).toBe(1);
    expect(reboundSocket?.currentParams()).toEqual({
      token: refreshedToken,
    });
    expect(reboundChannel.joinCalls[0]).toEqual({ cursor: 1 });
    expect(errors).toEqual([]);

    reboundSocket?.emitOpen();
    reboundChannel.emitJoinOk({});
    reboundChannel.emit("events", {
      events: [makeEvent(2, "agent:planner-refreshed", 2)],
    });
    await flush();

    expect(refreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "token_expired",
        sessionId: "ses_refresh_tail",
      })
    );
    expect(seen).toEqual([
      { phase: "live", seq: 1 },
      { phase: "live", seq: 2 },
    ]);
    expect(session.identity.id).toBe("planner-refreshed");
    expect(session.events().map((event) => event.seq)).toEqual([1, 2]);

    stopError();
    stopEvents();
    session.disconnect();
  });

  it("manual refreshAuth reconnects the tail from the current cursor without duplicating retained replay", async () => {
    const refreshedToken = makeSessionToken(
      "ses_manual_refresh_tail",
      "planner-refreshed"
    );
    const refreshToken = vi.fn().mockResolvedValue(refreshedToken);
    const session = makeStarcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({
      token: makeSessionToken("ses_manual_refresh_tail"),
      refreshToken,
    });

    const seen: Array<{ phase: string; seq: number }> = [];
    const stopEvents = session.on("event", (event, context) => {
      seen.push({ phase: context.phase, seq: event.seq });
    });

    await waitForSocketCount(1);
    const initialSocket = phoenixMock.MockPhoenixSocket.instances[0];
    const initialChannel = await waitForChannel("tail:ses_manual_refresh_tail");
    initialSocket?.emitOpen();
    initialChannel.emitJoinOk({});
    initialChannel.emit("events", {
      events: [makeEvent(1, "agent:planner", 1)],
    });
    await flush();

    await expect(session.refreshAuth()).resolves.toBeUndefined();
    await waitForSocketCount(2);

    const reboundSocket = phoenixMock.MockPhoenixSocket.instances[1];
    const [, reboundChannel] = await waitForChannels(
      "tail:ses_manual_refresh_tail",
      2
    );
    expect(initialChannel.leaveCalls).toBe(1);
    expect(reboundSocket?.currentParams()).toEqual({
      token: refreshedToken,
    });
    expect(reboundChannel.joinCalls[0]).toEqual({ cursor: 1 });

    reboundSocket?.emitOpen();
    reboundChannel.emitJoinOk({});
    reboundChannel.emit("events", {
      events: [makeEvent(2, "agent:planner-refreshed", 2)],
    });
    await flush();

    expect(refreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual",
        sessionId: "ses_manual_refresh_tail",
      })
    );
    expect(seen).toEqual([
      { phase: "live", seq: 1 },
      { phase: "live", seq: 2 },
    ]);

    stopEvents();
    session.disconnect();
  });

  it("surfaces refresh failures and allows manual refresh retry recovery", async () => {
    const refreshToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("reauth denied"))
      .mockResolvedValueOnce(
        makeSessionToken("ses_refresh_retry_tail", "planner-recovered")
      );
    const session = makeStarcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({
      token: makeSessionToken("ses_refresh_retry_tail"),
      refreshToken,
    });

    const errors: Error[] = [];
    const seen: number[] = [];
    const stopError = session.on("error", (error) => {
      errors.push(error);
    });
    const stopEvents = session.on("event", (event) => {
      seen.push(event.seq);
    });

    await waitForSocketCount(1);
    const initialSocket = phoenixMock.MockPhoenixSocket.instances[0];
    const initialChannel = await waitForChannel("tail:ses_refresh_retry_tail");
    initialSocket?.emitOpen();
    initialChannel.emitJoinOk({});
    initialChannel.emit("events", {
      events: [makeEvent(1, "agent:planner", 1)],
    });
    await flush();

    initialChannel.emit("token_expired", { reason: "token_expired" });
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("reauth denied");

    await expect(session.refreshAuth()).resolves.toBeUndefined();
    await waitForSocketCount(2);

    const reboundSocket = phoenixMock.MockPhoenixSocket.instances[1];
    const [, reboundChannel] = await waitForChannels(
      "tail:ses_refresh_retry_tail",
      2
    );
    expect(reboundSocket?.currentParams()).toEqual({
      token: makeSessionToken("ses_refresh_retry_tail", "planner-recovered"),
    });
    expect(reboundChannel.joinCalls[0]).toEqual({ cursor: 1 });

    reboundSocket?.emitOpen();
    reboundChannel.emitJoinOk({});
    reboundChannel.emit("events", {
      events: [makeEvent(2, "agent:planner-recovered", 2)],
    });
    await flush();

    expect(seen).toEqual([1, 2]);
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(session.identity.id).toBe("planner-recovered");

    stopError();
    stopEvents();
    session.disconnect();
  });

  it("retries tail joins after a timeout without surfacing an error", async () => {
    const session = makeStarcite({
      baseUrl: "http://localhost:4000",
      fetch: vi.fn<typeof fetch>(),
    }).session({ token: makeSessionToken("ses_join_timeout_retry") });

    const errors: Error[] = [];
    const seen: number[] = [];
    const stopError = session.on("error", (error) => {
      errors.push(error);
    });
    const stopEvents = session.on("event", (event) => {
      seen.push(event.seq);
    });

    await waitForSocketCount(1);
    const socket = phoenixMock.MockPhoenixSocket.instances[0];
    const channel = await waitForChannel("tail:ses_join_timeout_retry");
    socket?.emitOpen();
    channel.emitJoinTimeout();
    await flush();

    expect(errors).toEqual([]);
    expect(channel.rejoinCalls.at(-1)).toEqual({ cursor: 0 });

    channel.emitJoinOk({});
    channel.emit("events", {
      events: [makeEvent(1, "agent:planner", 1)],
    });
    await flush();

    expect(seen).toEqual([1]);

    stopError();
    stopEvents();
    session.disconnect();
  });

  it("surfaces join failures to session error listeners", async () => {
    const session = makeStarcite({
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

  it("cleans up channels per session and disconnects session-scoped sockets when each handle disconnects", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeSessionRecord("ses_one"))
      .mockResolvedValueOnce(makeTokenResponse("ses_one"))
      .mockResolvedValueOnce(makeSessionRecord("ses_two"))
      .mockResolvedValueOnce(makeTokenResponse("ses_two"));

    const client = makeStarcite({
      apiKey: makeApiKey(),
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const identity = client.agent({ id: "planner" });
    const one = await client.session({ identity, id: "ses_one" });
    const two = await client.session({ identity, id: "ses_two" });

    await waitForSocketCount(2);
    const oneSocket = phoenixMock.MockPhoenixSocket.instances[0];
    const twoSocket = phoenixMock.MockPhoenixSocket.instances[1];
    const oneChannel = await waitForChannel("tail:ses_one");
    const twoChannel = await waitForChannel("tail:ses_two");

    one.disconnect();
    await flush();
    expect(oneChannel.leaveCalls).toBe(1);
    expect(oneSocket?.disconnectCalls).toHaveLength(1);
    expect(twoSocket?.disconnectCalls).toHaveLength(0);

    two.disconnect();
    await flush();
    expect(twoChannel.leaveCalls).toBe(1);
    expect(twoSocket?.disconnectCalls).toHaveLength(1);
  });
});
