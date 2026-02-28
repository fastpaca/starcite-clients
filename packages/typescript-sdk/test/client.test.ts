import { beforeEach, describe, expect, it, vi } from "vitest";
import { Starcite } from "../src/client";
import {
  StarciteConnectionError,
  StarciteError,
  StarciteTailError,
} from "../src/errors";
import type {
  SessionCursorStore,
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

function tokenFromClaims(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url"
  );
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.N6fK2qA`;
}

/**
 * Creates a session token with standard claims for WebSocket/tail tests.
 * This avoids HTTP calls -- `starcite.session({ token })` decodes the JWT locally.
 */
function makeTailSessionToken(
  sessionId = "ses_tail",
  principalId = "agent:drafter"
): string {
  return tokenFromClaims({
    session_id: sessionId,
    tenant_id: "test-tenant",
    principal_id: principalId,
    principal_type: principalId.startsWith("agent:") ? "agent" : "user",
  });
}

/**
 * Creates an API key JWT with standard claims for client construction tests.
 */
function makeApiKey(
  overrides: Record<string, unknown> = {}
): string {
  return tokenFromClaims({
    iss: "https://starcite.ai",
    tenant_id: "test-tenant",
    principal_id: "user:system",
    principal_type: "user",
    ...overrides,
  });
}

/**
 * Builds a `Starcite` instance wired to a fake WebSocket factory and
 * returns both the client and the captured sockets list.
 */
function buildTailClient(fetchMock: ReturnType<typeof vi.fn>) {
  const sockets: FakeWebSocket[] = [];
  const starcite = new Starcite({
    baseUrl: "http://localhost:4000",
    fetch: fetchMock,
    websocketFactory: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  return { starcite, sockets };
}

describe("Starcite", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("creates sessions and appends events using /v1 routes", async () => {
    const apiKey = makeApiKey();

    // session({ identity }) makes two HTTP calls: create session + mint token
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ses_1",
            title: "Draft",
            metadata: {},
            last_seq: 0,
            created_at: "2026-02-11T00:00:00Z",
            updated_at: "2026-02-11T00:00:00Z",
          }),
          { status: 201 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: makeTailSessionToken("ses_1", "agent:researcher"),
            expires_in: 3600,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ seq: 1, last_seq: 1, deduped: false }), {
          status: 201,
        })
      );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey,
    });

    const identity = starcite.agent({ id: "researcher" });
    const session = await starcite.session({ identity, title: "Draft" });

    expect(session.id).toBe("ses_1");

    await session.append({
      producerId: "producer:researcher",
      producerSeq: 1,
      text: "Found 8 relevant cases...",
    });

    // First call: create session
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/v1/sessions",
      expect.objectContaining({
        method: "POST",
      })
    );

    // Second call: mint session token (goes to auth issuer)
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://starcite.ai/api/v1/session-tokens",
      expect.objectContaining({
        method: "POST",
      })
    );

    // Third call: append event
    const thirdCall = fetchMock.mock.calls[2];
    expect(thirdCall?.[0]).toBe(
      "http://localhost:4000/v1/sessions/ses_1/append"
    );

    const requestInit = thirdCall?.[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(requestInit.body).toBe(
      JSON.stringify({
        type: "content",
        payload: { text: "Found 8 relevant cases..." },
        actor: "agent:researcher",
        producer_id: "producer:researcher",
        producer_seq: 1,
        source: "agent",
      })
    );
  });

  it("validates baseUrl at client construction", () => {
    expect(
      () =>
        new Starcite({
          baseUrl: "localhost:4000",
          fetch: fetchMock,
        })
    ).toThrowError(StarciteError);
  });

  it("mints session tokens via the session() identity flow using API key issuer authority", async () => {
    const apiKey = makeApiKey({
      iss: "https://starcite.ai",
      tenant_id: "tenant-a",
    });

    // session({ identity, id }) skips create (existing session) but still mints a token
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ token: "jwt_session_token", expires_in: 3600 }),
        { status: 200 }
      )
    );

    const starcite = new Starcite({
      baseUrl: "https://tenant-a.starcite.io",
      fetch: fetchMock,
      apiKey,
    });

    const identity = starcite.user({ id: "user-42" });
    await starcite.session({ identity, id: "ses_demo" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://starcite.ai/api/v1/session-tokens",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("uses authUrl override for session token minting", async () => {
    const apiKey = makeApiKey({
      iss: "https://ignored-auth-origin.example",
      tenant_id: "tenant-a",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ token: "jwt_session_token", expires_in: 900 }),
        { status: 200 }
      )
    );

    const starcite = new Starcite({
      baseUrl: "https://tenant-a.starcite.io",
      authUrl: "https://auth.starcite.example",
      fetch: fetchMock,
      apiKey,
    });

    const identity = starcite.agent({ id: "agent-7" });
    await starcite.session({ identity, id: "ses_demo" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.starcite.example/api/v1/session-tokens",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("fails session creation when apiKey is missing", async () => {
    const sessionToken = makeTailSessionToken("ses_demo", "user:user-42");
    const starcite = new Starcite({
      baseUrl: "https://tenant-a.starcite.io",
      fetch: fetchMock,
    });

    // session({ token }) works without apiKey
    const session = await starcite.session({ token: sessionToken, id: "ses_demo" });
    expect(session.id).toBe("ses_demo");

    // But agent()/user() require apiKey to infer tenant
    expect(() => starcite.agent({ id: "agent-7" })).toThrowError(StarciteError);
  });

  it("wraps malformed JSON success responses as connection errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not json", {
        status: 200,
      })
    );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    await expect(starcite.listSessions()).rejects.toBeInstanceOf(
      StarciteConnectionError
    );
  });

  it("applies bearer authorization header from apiKey for HTTP requests", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessions: [],
          next_cursor: null,
        }),
        { status: 200 }
      )
    );

    const apiKey = makeApiKey();

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey,
    });

    await starcite.listSessions();

    const firstCall = fetchMock.mock.calls[0];
    const requestInit = firstCall?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);

    expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  it("injects inferred creator_principal from JWT apiKey via identity", async () => {
    const apiKey = tokenFromClaims({
      iss: "https://starcite.ai",
      aud: "starcite-api",
      sub: "agent-99",
      tenant_id: "tenant-alpha",
      principal_id: "user-99",
      principal_type: "user",
    });

    // session({ identity }) calls create session + mint token
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ses_auth_claims",
            title: "Auth",
            metadata: {},
            last_seq: 0,
            created_at: "2026-02-14T00:00:00Z",
            updated_at: "2026-02-14T00:00:00Z",
          }),
          { status: 201 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: makeTailSessionToken("ses_auth_claims", "agent:planner"),
            expires_in: 3600,
          }),
          { status: 200 }
        )
      );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey,
    });

    const identity = starcite.agent({ id: "planner" });
    await starcite.session({ identity, title: "Auth" });

    const firstCall = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(
      (firstCall?.[1] as RequestInit).body as string
    );
    expect(requestBody.creator_principal).toEqual({
      tenant_id: "tenant-alpha",
      id: "planner",
      type: "agent",
    });
  });

  it("identity factories produce correct principal types", () => {
    const apiKey = makeApiKey({ tenant_id: "tenant-alpha" });

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey,
    });

    const agentIdentity = starcite.agent({ id: "planner" });
    expect(agentIdentity.toCreatorPrincipal()).toEqual({
      tenant_id: "tenant-alpha",
      id: "planner",
      type: "agent",
    });

    const userIdentity = starcite.user({ id: "alice" });
    expect(userIdentity.toCreatorPrincipal()).toEqual({
      tenant_id: "tenant-alpha",
      id: "alice",
      type: "user",
    });
  });

  it("uses explicit tenant_id from API key claims", async () => {
    const apiKey = makeApiKey({
      iss: "https://starcite.ai",
      tenant_id: "tenant-alpha",
    });

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ses_org_subject",
            title: "Auth",
            metadata: {},
            last_seq: 0,
            created_at: "2026-02-14T00:00:00Z",
            updated_at: "2026-02-14T00:00:00Z",
          }),
          { status: 201 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: makeTailSessionToken("ses_org_subject", "agent:foo"),
            expires_in: 3600,
          }),
          { status: 200 }
        )
      );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey,
    });

    const identity = starcite.agent({ id: "foo" });
    await starcite.session({ identity, title: "Auth" });

    const firstCall = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(
      (firstCall?.[1] as RequestInit).body as string
    );
    expect(requestBody.creator_principal).toEqual({
      tenant_id: "tenant-alpha",
      id: "foo",
      type: "agent",
    });
  });

  it("tails events and filters by agent", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken("ses_tail", "agent:drafter");
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({ agent: "drafter", cursor: 0 })
      [Symbol.asyncIterator]();

    const firstValuePromise = iterator.next();

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "ignore me" },
        actor: "agent:researcher",
        producer_id: "producer:researcher",
        producer_seq: 10,
      }),
    });

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "Drafting clause 4.2..." },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 11,
      }),
    });

    const first = await firstValuePromise;

    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      seq: 2,
      actor: "agent:drafter",
      payload: { text: "Drafting clause 4.2..." },
    });

    const donePromise = iterator.next();
    sockets[0]?.emit("close", { code: 1000 });

    await expect(donePromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(sockets[0]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0"
    );
  });

  it("tails batched frames and appends batch_size query param", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({ cursor: 0, batchSize: 2 })
      [Symbol.asyncIterator]();

    const firstValuePromise = iterator.next();
    const secondValuePromise = iterator.next();

    sockets[0]?.emit("message", {
      data: JSON.stringify([
        {
          seq: 1,
          type: "content",
          payload: { text: "first frame" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 1,
        },
        {
          seq: 2,
          type: "content",
          payload: { text: "second frame" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 2,
        },
      ]),
    });

    await expect(firstValuePromise).resolves.toMatchObject({
      done: false,
      value: { seq: 1 },
    });
    await expect(secondValuePromise).resolves.toMatchObject({
      done: false,
      value: { seq: 2 },
    });

    const donePromise = iterator.next();
    sockets[0]?.emit("close", { code: 1000 });

    await expect(donePromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(sockets[0]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0&batch_size=2"
    );
  });

  it("tails event batches without flattening", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tailBatches({ cursor: 0, batchSize: 2 })
      [Symbol.asyncIterator]();
    const firstBatchPromise = iterator.next();

    sockets[0]?.emit("message", {
      data: JSON.stringify([
        {
          seq: 1,
          type: "content",
          payload: { text: "first frame" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 1,
        },
        {
          seq: 2,
          type: "content",
          payload: { text: "second frame" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 2,
        },
      ]),
    });

    const firstBatch = await firstBatchPromise;
    expect(firstBatch.done).toBe(false);
    expect(firstBatch.value?.map((event) => event.seq)).toEqual([1, 2]);

    const donePromise = iterator.next();
    sockets[0]?.emit("close", { code: 1000 });
    await expect(donePromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("tails event batches for batched ingestion", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tailBatches({ cursor: 0, batchSize: 2 })
      [Symbol.asyncIterator]();
    const firstBatchPromise = iterator.next();

    sockets[0]?.emit("message", {
      data: JSON.stringify([
        {
          seq: 1,
          type: "content",
          payload: { text: "Draft one" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 1,
        },
        {
          seq: 2,
          type: "content",
          payload: { text: "Draft two" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 2,
        },
      ]),
    });

    const firstBatch = await firstBatchPromise;
    expect(firstBatch.done).toBe(false);
    expect(firstBatch.value).toMatchObject([
      { seq: 1, actor: "agent:drafter", payload: { text: "Draft one" } },
      { seq: 2, actor: "agent:drafter", payload: { text: "Draft two" } },
    ]);

    const donePromise = iterator.next();
    sockets[0]?.emit("close", { code: 1000 });
    await expect(donePromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("sends authorization header in websocket upgrade when apiKey is set", async () => {
    const sockets: FakeWebSocket[] = [];
    const websocketFactory = vi.fn(
      (url: string, options?: { headers?: HeadersInit }) => {
        const headers = new Headers(options?.headers);
        // Session token auth is used for the WebSocket, not the API key
        expect(headers.get("authorization")).toMatch(/^Bearer /);

        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: makeApiKey(),
      websocketFactory,
    });

    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session.tail()[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    sockets[0]?.emit("close", { code: 1000 });

    await expect(nextPromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(websocketFactory).toHaveBeenCalledWith(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0",
      expect.objectContaining({
        headers: expect.anything(),
      })
    );
  });

  it("supports access_token query auth for websocket tail", async () => {
    const sockets: FakeWebSocket[] = [];
    const websocketFactory = vi.fn(
      (url: string, options?: { headers?: HeadersInit }) => {
        const headers = new Headers(options?.headers);
        expect(headers.get("authorization")).toBeNull();

        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: makeApiKey(),
      websocketFactory,
      websocketAuthTransport: "access_token",
    });

    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session.tail()[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    sockets[0]?.emit("close", { code: 1000 });

    await expect(nextPromise).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(websocketFactory).toHaveBeenCalledWith(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0&access_token="
      ),
      undefined
    );
  });

  it("throws a token-expired connection error on close code 4001", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session.tail()[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    sockets[0]?.emit("close", { code: 4001, reason: "token_expired" });

    const error = await nextPromise.catch((err) => err);
    expect(error).toBeInstanceOf(StarciteConnectionError);
    expect((error as Error).message).toContain("token expired");
  });

  it("reconnects on abnormal close and resumes from the last observed seq", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({
        cursor: 0,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
        },
      })
      [Symbol.asyncIterator]();

    const firstPromise = iterator.next();

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "first frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 1,
      }),
    });

    await expect(firstPromise).resolves.toMatchObject({
      done: false,
      value: { seq: 1 },
    });

    const secondPromise = iterator.next();
    sockets[0]?.emit("close", { code: 1006, reason: "upstream reset" });

    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=1"
    );

    sockets[1]?.emit("message", {
      data: JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "recovered frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 2,
      }),
    });

    await expect(secondPromise).resolves.toMatchObject({
      done: false,
      value: { seq: 2 },
    });

    const donePromise = iterator.next();
    sockets[1]?.emit("close", { code: 1000 });

    await expect(donePromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("resumes from the latest seq in a batched frame after reconnect", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({
        cursor: 0,
        batchSize: 2,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
        },
      })
      [Symbol.asyncIterator]();

    const firstValuePromise = iterator.next();
    const secondValuePromise = iterator.next();

    sockets[0]?.emit("message", {
      data: JSON.stringify([
        {
          seq: 1,
          type: "content",
          payload: { text: "first frame" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 1,
        },
        {
          seq: 2,
          type: "content",
          payload: { text: "second frame" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 2,
        },
      ]),
    });

    await expect(firstValuePromise).resolves.toMatchObject({
      done: false,
      value: { seq: 1 },
    });
    await expect(secondValuePromise).resolves.toMatchObject({
      done: false,
      value: { seq: 2 },
    });

    const thirdValuePromise = iterator.next();
    sockets[0]?.emit("close", { code: 1006, reason: "upstream reset" });

    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=2&batch_size=2"
    );

    sockets[1]?.emit("message", {
      data: JSON.stringify({
        seq: 3,
        type: "content",
        payload: { text: "recovered frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 3,
      }),
    });

    await expect(thirdValuePromise).resolves.toMatchObject({
      done: false,
      value: { seq: 3 },
    });

    const donePromise = iterator.next();
    sockets[1]?.emit("close", { code: 1000 });

    await expect(donePromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("resumes batched ingestion from latest observed seq after reconnect", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tailBatches({
        cursor: 0,
        batchSize: 2,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
        },
      })
      [Symbol.asyncIterator]();

    const firstBatchPromise = iterator.next();
    sockets[0]?.emit("message", {
      data: JSON.stringify([
        {
          seq: 1,
          type: "content",
          payload: { text: "first frame" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 1,
        },
        {
          seq: 2,
          type: "content",
          payload: { text: "second frame" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 2,
        },
      ]),
    });

    const firstBatch = await firstBatchPromise;
    expect(firstBatch.done).toBe(false);
    expect(firstBatch.value?.map((event) => event.seq)).toEqual([1, 2]);

    const secondBatchPromise = iterator.next();
    sockets[0]?.emit("close", { code: 1006, reason: "upstream reset" });

    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=2&batch_size=2"
    );

    sockets[1]?.emit("message", {
      data: JSON.stringify({
        seq: 3,
        type: "content",
        payload: { text: "recovered frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 3,
      }),
    });

    const secondBatch = await secondBatchPromise;
    expect(secondBatch.done).toBe(false);
    expect(secondBatch.value?.map((event) => event.seq)).toEqual([3]);

    const donePromise = iterator.next();
    sockets[1]?.emit("close", { code: 1000 });
    await expect(donePromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("keeps reconnecting until the transport recovers", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
        },
      })
      [Symbol.asyncIterator]();
    const firstValuePromise = iterator.next();

    sockets[0]?.emit("close", { code: 1006, reason: "deployment restart" });

    await waitForSocketCount(sockets, 2);
    sockets[1]?.emit("close", { code: 1006, reason: "network still down" });
    await waitForSocketCount(sockets, 3);

    sockets[2]?.emit("message", {
      data: JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "stream resumed" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 1,
      }),
    });

    await expect(firstValuePromise).resolves.toMatchObject({
      done: false,
      value: { seq: 1 },
    });

    const donePromise = iterator.next();
    sockets[2]?.emit("close", { code: 1000 });

    await expect(donePromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("fails when reconnectPolicy maxAttempts is exceeded", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({
        reconnect: true,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
          maxAttempts: 1,
        },
      })
      [Symbol.asyncIterator]();
    const firstValuePromise = iterator.next();

    sockets[0]?.emit("close", { code: 1006, reason: "deployment restart" });
    await waitForSocketCount(sockets, 2);
    sockets[1]?.emit("close", { code: 1006, reason: "network still down" });

    await expect(firstValuePromise).rejects.toBeInstanceOf(StarciteTailError);

    await firstValuePromise.catch((error) => {
      const tailError = error as StarciteTailError;
      expect(tailError.stage).toBe("retry_limit");
      expect(tailError.sessionId).toBe("ses_tail");
      expect(tailError.closeCode).toBe(1006);
    });
  });

  it("supports zero reconnect attempts via reconnectPolicy", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({
        reconnect: true,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
          maxAttempts: 0,
        },
      })
      [Symbol.asyncIterator]();
    const firstValuePromise = iterator.next();

    sockets[0]?.emit("close", { code: 1006, reason: "deployment restart" });

    await expect(firstValuePromise).rejects.toBeInstanceOf(StarciteTailError);
    await firstValuePromise.catch((error) => {
      const tailError = error as StarciteTailError;
      expect(tailError.stage).toBe("retry_limit");
      expect(tailError.sessionId).toBe("ses_tail");
      expect(tailError.attempts).toBe(1);
      expect(tailError.closeCode).toBe(1006);
    });
    expect(sockets).toHaveLength(1);
  });

  it("emits lifecycle events for dropped streams", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const lifecycleEvents: TailLifecycleEvent[] = [];
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({
        reconnect: true,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
          maxAttempts: 0,
        },
        onLifecycleEvent: (event) => {
          lifecycleEvents.push(event);
        },
      })
      [Symbol.asyncIterator]();
    const firstValuePromise = iterator.next();

    sockets[0]?.emit("close", { code: 1006, reason: "deployment restart" });
    await expect(firstValuePromise).rejects.toBeInstanceOf(StarciteTailError);

    expect(lifecycleEvents).toHaveLength(2);
    expect(lifecycleEvents[0]).toMatchObject({
      type: "connect_attempt",
      sessionId: "ses_tail",
      attempt: 1,
      cursor: 0,
    });
    expect(lifecycleEvents[1]).toMatchObject({
      type: "stream_dropped",
      sessionId: "ses_tail",
      attempt: 1,
      closeCode: 1006,
      closeReason: "deployment restart",
    });
  });

  it("ignores lifecycle callback exceptions", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({
        reconnect: false,
        onLifecycleEvent: () => {
          throw new Error("observer failure");
        },
      })
      [Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    sockets[0]?.emit("close", { code: 1000, reason: "done" });

    await expect(nextPromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("lists sessions with pagination and metadata filters", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessions: [
            {
              id: "ses_a",
              title: "A",
              metadata: { tenant_id: "acme" },
              created_at: "2026-02-13T00:00:00Z",
            },
          ],
          next_cursor: "ses_a",
        }),
        { status: 200 }
      )
    );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    const page = await starcite.listSessions({
      limit: 1,
      cursor: "ses_0",
      metadata: { tenant_id: "acme" },
    });

    expect(page.sessions[0]?.id).toBe("ses_a");
    expect(page.next_cursor).toBe("ses_a");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/v1/sessions?limit=1&cursor=ses_0&metadata.tenant_id=acme",
      expect.objectContaining({
        method: "GET",
      })
    );
  });

  it("raises a connection error on malformed tail data", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session.tail()[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    sockets[0]?.emit("message", { data: "not json" });

    await expect(nextPromise).rejects.toBeInstanceOf(StarciteConnectionError);
  });

  it("fails fast when the tail consumer falls behind buffered batches", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({
        cursor: 0,
        reconnect: false,
        maxBufferedBatches: 1,
      })
      [Symbol.asyncIterator]();

    const firstValuePromise = iterator.next();
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "first frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 1,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "second frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 2,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 3,
        type: "content",
        payload: { text: "third frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 3,
      }),
    });

    await expect(firstValuePromise).resolves.toMatchObject({
      done: false,
      value: { seq: 1 },
    });

    const secondValuePromise = iterator.next();
    await expect(secondValuePromise).resolves.toMatchObject({
      done: false,
      value: { seq: 2 },
    });

    const overflowPromise = iterator.next();
    await expect(overflowPromise).rejects.toBeInstanceOf(StarciteTailError);
    await overflowPromise.catch((error) => {
      const tailError = error as StarciteTailError;
      expect(tailError.stage).toBe("consumer_backpressure");
      expect(tailError.sessionId).toBe("ses_tail");
    });
  });

  it("consume() resumes from cursor store and checkpoints each handled event", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const load = vi.fn(async () => 4);
    const save = vi.fn(async () => undefined);
    const cursorStore: SessionCursorStore = { load, save };
    const handledSeqs: number[] = [];

    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const consumePromise = session.consume({
      cursorStore,
      reconnect: false,
      handler: (event) => {
        handledSeqs.push(event.seq);
      },
    });

    await waitForSocketCount(sockets, 1);
    expect(sockets[0]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=4"
    );

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 5,
        type: "content",
        payload: { text: "first frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 5,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 6,
        type: "content",
        payload: { text: "second frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 6,
      }),
    });
    sockets[0]?.emit("close", { code: 1000, reason: "done" });

    await consumePromise;

    expect(handledSeqs).toEqual([5, 6]);
    expect(load).toHaveBeenCalledWith("ses_tail");
    expect(save).toHaveBeenNthCalledWith(1, "ses_tail", 5);
    expect(save).toHaveBeenNthCalledWith(2, "ses_tail", 6);
  });

  it("consume() fails when cursor persistence fails", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const load = vi.fn(async () => 0);
    const save = vi
      .fn(async () => undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    const cursorStore: SessionCursorStore = { load, save };

    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const consumePromise = session.consume({
      cursorStore,
      reconnect: false,
      handler: () => undefined,
    });

    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "first frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 1,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "second frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 2,
      }),
    });

    await expect(consumePromise).rejects.toBeInstanceOf(StarciteError);
    expect(save).toHaveBeenNthCalledWith(1, "ses_tail", 1);
    expect(save).toHaveBeenNthCalledWith(2, "ses_tail", 2);
  });

  it("consume() uses stored cursor values as-is", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const consumePromise = session.consume({
      cursorStore: {
        load: async () => -1,
        save: async () => undefined,
      },
      handler: async () => undefined,
    });

    await waitForSocketCount(sockets, 1);
    expect(sockets[0]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=-1"
    );

    sockets[0]?.emit("close", { code: 1000 });
    await expect(consumePromise).resolves.toBeUndefined();
  });

  it("does not fail fast when maxBufferedBatches is provided", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({ maxBufferedBatches: 0 })
      [Symbol.asyncIterator]();

    const nextPromise = iterator.next();
    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("close", { code: 1000 });
    await expect(nextPromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("does not fail fast when batchSize is provided", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const iterator = session
      .tail({ batchSize: 0 })
      [Symbol.asyncIterator]();

    const nextPromise = iterator.next();
    await waitForSocketCount(sockets, 1);
    expect(sockets[0]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0&batch_size=0"
    );
    sockets[0]?.emit("close", { code: 1000 });
    await expect(nextPromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
