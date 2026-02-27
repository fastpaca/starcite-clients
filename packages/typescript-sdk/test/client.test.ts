import { beforeEach, describe, expect, it, vi } from "vitest";
import { StarciteClient } from "../src/client";
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

describe("StarciteClient", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("creates sessions and appends events using /v1 routes", async () => {
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
        new Response(JSON.stringify({ seq: 1, last_seq: 1, deduped: false }), {
          status: 201,
        })
      );

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    const session = await client.create({ title: "Draft" });

    expect(session.id).toBe("ses_1");

    await session.append({
      agent: "researcher",
      producerId: "producer:researcher",
      producerSeq: 1,
      text: "Found 8 relevant cases...",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/v1/sessions",
      expect.objectContaining({
        method: "POST",
      })
    );

    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall?.[0]).toBe(
      "http://localhost:4000/v1/sessions/ses_1/append"
    );

    const requestInit = secondCall?.[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(requestInit.body).toBe(
      JSON.stringify({
        type: "content",
        payload: { text: "Found 8 relevant cases..." },
        producer_id: "producer:researcher",
        producer_seq: 1,
        source: "agent",
      })
    );
  });

  it("mints session tokens using API key issuer authority instead of API base URL", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ token: "jwt_session_token", expires_in: 3600 }),
        {
          status: 200,
        }
      )
    );

    const client = new StarciteClient({
      baseUrl: "https://tenant-a.starcite.io",
      fetch: fetchMock,
      apiKey: tokenFromClaims({
        iss: "https://starcite.ai",
        aud: "starcite-api",
        sub: "org:tenant-a",
      }),
    });

    const issued = await client.issueSessionToken({
      session_id: "ses_demo",
      principal: { type: "user", id: "user-42" },
      scopes: ["session:read", "session:append"],
      ttl_seconds: 3600,
    });

    expect(issued).toEqual({ token: "jwt_session_token", expires_in: 3600 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://starcite.ai/api/v1/session-tokens",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("uses authUrl override for session token minting", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ token: "jwt_session_token", expires_in: 900 }),
        {
          status: 200,
        }
      )
    );

    const client = new StarciteClient({
      baseUrl: "https://tenant-a.starcite.io",
      authUrl: "https://auth.starcite.example",
      fetch: fetchMock,
      apiKey: tokenFromClaims({
        iss: "https://ignored-auth-origin.example",
        aud: "starcite-api",
        sub: "org:tenant-a",
      }),
    });

    await client.issueSessionToken({
      session_id: "ses_demo",
      principal: { type: "agent", id: "agent-7" },
      scopes: ["session:read"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.starcite.example/api/v1/session-tokens",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("fails session token minting when apiKey is missing", () => {
    const client = new StarciteClient({
      baseUrl: "https://tenant-a.starcite.io",
      fetch: fetchMock,
    });

    expect(() =>
      client.issueSessionToken({
        session_id: "ses_demo",
        principal: { type: "user", id: "user-42" },
        scopes: ["session:read"],
      })
    ).toThrowError(StarciteError);
  });

  it("wraps malformed JSON success responses as connection errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not json", {
        status: 200,
      })
    );

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    await expect(client.listSessions()).rejects.toBeInstanceOf(
      StarciteConnectionError
    );
  });

  it("applies bearer authorization header from apiKey for HTTP requests", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ses_auth",
          title: "Auth",
          metadata: {},
          last_seq: 0,
          created_at: "2026-02-14T00:00:00Z",
          updated_at: "2026-02-14T00:00:00Z",
        }),
        { status: 201 }
      )
    );

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: "jwt_service_key",
    });

    await client.create({ title: "Auth" });

    const firstCall = fetchMock.mock.calls[0];
    const requestInit = firstCall?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);

    expect(headers.get("authorization")).toBe("Bearer jwt_service_key");
  });

  it("injects inferred creator_principal from JWT apiKey", async () => {
    fetchMock.mockResolvedValueOnce(
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
    );

    const apiKey = tokenFromClaims({
      iss: "https://starcite.ai",
      aud: "starcite-api",
      sub: "agent-99",
      tenant_id: "tenant-alpha",
      principal_id: "user-99",
      principal_type: "user",
    });

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey,
    });

    await client.create({ title: "Auth" });

    const firstCall = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(
      (firstCall?.[1] as RequestInit).body as string
    );
    expect(requestBody.creator_principal).toEqual({
      tenant_id: "tenant-alpha",
      id: "user-99",
      type: "user",
    });
  });

  it("uses explicit creator_principal when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ses_auth_explicit",
          title: "Auth",
          metadata: {},
          last_seq: 0,
          created_at: "2026-02-14T00:00:00Z",
          updated_at: "2026-02-14T00:00:00Z",
        }),
        { status: 201 }
      )
    );

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: tokenFromClaims({
        iss: "https://starcite.ai",
        aud: "starcite-api",
        sub: "org:tenant-alpha",
      }),
    });

    await client.create({
      title: "Auth",
      creator_principal: {
        tenant_id: "tenant-beta",
        id: "agent-beta",
        type: "agent",
      },
    });

    const firstCall = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(
      (firstCall?.[1] as RequestInit).body as string
    );
    expect(requestBody.creator_principal).toEqual({
      tenant_id: "tenant-beta",
      id: "agent-beta",
      type: "agent",
    });
  });

  it("infers actor-style creator principal from JWT subject", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ses_auth_actor_subject",
          title: "Auth",
          metadata: {},
          last_seq: 0,
          created_at: "2026-02-14T00:00:00Z",
          updated_at: "2026-02-14T00:00:00Z",
        }),
        { status: 201 }
      )
    );

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: tokenFromClaims({
        iss: "https://starcite.ai",
        aud: "starcite-api",
        sub: "agent:foo",
        tenant_id: "tenant-alpha",
      }),
    });

    await client.create({ title: "Auth" });

    const firstCall = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(
      (firstCall?.[1] as RequestInit).body as string
    );
    expect(requestBody.creator_principal).toEqual({
      tenant_id: "tenant-alpha",
      id: "agent:foo",
      type: "agent",
    });
  });

  it("infers principal tenant from org-style service token subject", async () => {
    fetchMock.mockResolvedValueOnce(
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
    );

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: tokenFromClaims({
        iss: "https://starcite.ai",
        aud: "starcite-api",
        sub: "org:tenant-alpha",
      }),
    });

    await client.create({ title: "Auth" });

    const firstCall = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(
      (firstCall?.[1] as RequestInit).body as string
    );
    expect(requestBody.creator_principal).toEqual({
      tenant_id: "tenant-alpha",
      id: "org:tenant-alpha",
      type: "user",
    });
  });

  it("tails events and filters by agent", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
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
      agent: "drafter",
      text: "Drafting clause 4.2...",
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({ cursor: 0, batchSize: 2 })
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

  it("tails raw event batches without flattening", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRawBatches({ cursor: 0, batchSize: 2 })
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

  it("tails transformed event batches for batched ingestion", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
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
      { seq: 1, agent: "drafter", text: "Draft one" },
      { seq: 2, agent: "drafter", text: "Draft two" },
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
        expect(headers.get("authorization")).toBe("Bearer jwt_service_key");

        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    );

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: "jwt_service_key",
      websocketFactory,
    });

    const iterator = client.session("ses_tail").tail()[Symbol.asyncIterator]();
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

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: "jwt_service_key",
      websocketFactory,
      websocketAuthTransport: "access_token",
    });

    const iterator = client.session("ses_tail").tail()[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    sockets[0]?.emit("close", { code: 1000 });

    await expect(nextPromise).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(websocketFactory).toHaveBeenCalledWith(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0&access_token=jwt_service_key",
      undefined
    );
  });

  it("throws a token-expired connection error on close code 4001", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client.session("ses_tail").tail()[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    sockets[0]?.emit("close", { code: 4001, reason: "token_expired" });

    const error = await nextPromise.catch((err) => err);
    expect(error).toBeInstanceOf(StarciteConnectionError);
    expect((error as Error).message).toContain("token expired");
  });

  it("reconnects on abnormal close and resumes from the last observed seq", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRawBatches({
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({
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
    const sockets: FakeWebSocket[] = [];
    const lifecycleEvents: TailLifecycleEvent[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({
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

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    const page = await client.listSessions({
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client.session("ses_tail").tail()[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    sockets[0]?.emit("message", { data: "not json" });

    await expect(nextPromise).rejects.toBeInstanceOf(StarciteConnectionError);
  });

  it("fails fast when the tail consumer falls behind buffered batches", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({
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
    const sockets: FakeWebSocket[] = [];
    const load = vi.fn(async () => 4);
    const save = vi.fn(async () => undefined);
    const cursorStore: SessionCursorStore = { load, save };
    const handledSeqs: number[] = [];

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const consumePromise = client.session("ses_tail").consume({
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

  it("consumeRaw() fails when cursor persistence fails", async () => {
    const sockets: FakeWebSocket[] = [];
    const load = vi.fn(async () => 0);
    const save = vi
      .fn(async () => undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    const cursorStore: SessionCursorStore = { load, save };

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const consumePromise = client.session("ses_tail").consumeRaw({
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const consumePromise = client.session("ses_tail").consume({
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({ maxBufferedBatches: 0 })
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
    const sockets: FakeWebSocket[] = [];
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const iterator = client
      .session("ses_tail")
      .tailRaw({ batchSize: 0 })
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
