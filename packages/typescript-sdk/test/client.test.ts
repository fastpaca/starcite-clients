import { beforeEach, describe, expect, it, vi } from "vitest";
import { Starcite } from "../src/client";
import {
  StarciteApiError,
  StarciteBackpressureError,
  StarciteConnectionError,
  StarciteError,
  StarciteRetryLimitError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "../src/errors";
import type {
  StarciteWebSocket,
  StarciteWebSocketEventMap,
  TailEvent,
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

async function waitForValues<T>(
  values: T[],
  expectedCount: number
): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (values.length >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} value(s); saw ${values.length}`
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
function makeApiKey(overrides: Record<string, unknown> = {}): string {
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
    const body = JSON.parse(requestInit.body as string);
    expect(body).toEqual(
      expect.objectContaining({
        type: "content",
        payload: { text: "Found 8 relevant cases..." },
        actor: "agent:researcher",
        source: "agent",
      })
    );
    expect(body.producer_id).toEqual(expect.any(String));
    expect(body.producer_seq).toBe(1);
  });

  it("serializes concurrent appends for a session producer", async () => {
    const sessionToken = makeTailSessionToken("ses_serial", "agent:writer");
    let releaseFirstAppend: (() => void) | undefined;
    const firstAppendGate = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    let firstRequestObservedResolve: (() => void) | undefined;
    const firstRequestObserved = new Promise<void>((resolve) => {
      firstRequestObservedResolve = resolve;
    });

    fetchMock.mockImplementation(async (url, init) => {
      expect(url).toBe("http://localhost:4000/v1/sessions/ses_serial/append");
      const requestInit = init as RequestInit;
      const body = JSON.parse(requestInit.body as string) as {
        producer_seq: number;
      };

      if (body.producer_seq === 1) {
        firstRequestObservedResolve?.();
        await firstAppendGate;
      }

      return new Response(
        JSON.stringify({
          seq: body.producer_seq,
          last_seq: body.producer_seq,
          deduped: false,
        }),
        { status: 201 }
      );
    });

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = await starcite.session({ token: sessionToken });

    const firstAppend = session.append({ text: "one" });
    const secondAppend = session.append({ text: "two" });

    await firstRequestObserved;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirstAppend?.();
    await expect(Promise.all([firstAppend, secondAppend])).resolves.toEqual([
      { seq: 1, deduped: false },
      { seq: 2, deduped: false },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string
    ) as { producer_seq: number };
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string
    ) as { producer_seq: number };

    expect(firstBody.producer_seq).toBe(1);
    expect(secondBody.producer_seq).toBe(2);
  });

  it("retries transient append connection failures with the same producer sequence", async () => {
    vi.useFakeTimers();

    try {
      const sessionToken = makeTailSessionToken(
        "ses_retry_append",
        "agent:writer"
      );

      fetchMock
        .mockRejectedValueOnce(new Error("temporary network failure"))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ seq: 1, last_seq: 1, deduped: false }),
            {
              status: 201,
            }
          )
        );

      const starcite = new Starcite({
        baseUrl: "http://localhost:4000",
        fetch: fetchMock,
      });
      const session = await starcite.session({ token: sessionToken });

      const appendPromise = session.append({ text: "retry me" });

      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);

      await expect(appendPromise).resolves.toEqual({ seq: 1, deduped: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstBody = JSON.parse(
        (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string
      ) as { producer_seq: number; payload: { text: string } };
      const secondBody = JSON.parse(
        (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string
      ) as { producer_seq: number; payload: { text: string } };

      expect(firstBody.producer_seq).toBe(1);
      expect(secondBody.producer_seq).toBe(1);
      expect(secondBody.payload.text).toBe("retry me");
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues later appends behind a recovering append until connectivity returns", async () => {
    vi.useFakeTimers();

    try {
      const sessionToken = makeTailSessionToken(
        "ses_append_queue",
        "agent:writer"
      );
      let shouldFailFirstAttempt = true;

      fetchMock.mockImplementation((url, init) => {
        expect(url).toBe(
          "http://localhost:4000/v1/sessions/ses_append_queue/append"
        );
        const requestInit = init as RequestInit;
        const body = JSON.parse(requestInit.body as string) as {
          producer_seq: number;
        };

        if (body.producer_seq === 1 && shouldFailFirstAttempt) {
          shouldFailFirstAttempt = false;
          throw new Error("temporary network failure");
        }

        return new Response(
          JSON.stringify({
            seq: body.producer_seq,
            last_seq: body.producer_seq,
            deduped: false,
          }),
          { status: 201 }
        );
      });

      const starcite = new Starcite({
        baseUrl: "http://localhost:4000",
        fetch: fetchMock,
      });
      const session = await starcite.session({ token: sessionToken });

      const firstAppend = session.append({ text: "one" });
      const secondAppend = session.append({ text: "two" });

      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);

      await expect(Promise.all([firstAppend, secondAppend])).resolves.toEqual([
        { seq: 1, deduped: false },
        { seq: 2, deduped: false },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const requestBodies = fetchMock.mock.calls.map((call) => {
        return JSON.parse((call[1] as RequestInit).body as string) as {
          producer_seq: number;
        };
      });

      expect(requestBodies.map((body) => body.producer_seq)).toEqual([1, 1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries retryable append API responses before succeeding", async () => {
    vi.useFakeTimers();

    try {
      const sessionToken = makeTailSessionToken(
        "ses_retryable_status",
        "agent:writer"
      );

      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: "upstream_unavailable",
              message: "please retry",
            }),
            { status: 503, statusText: "Service Unavailable" }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ seq: 1, last_seq: 1, deduped: false }),
            {
              status: 201,
            }
          )
        );

      const starcite = new Starcite({
        baseUrl: "http://localhost:4000",
        fetch: fetchMock,
      });
      const session = await starcite.session({ token: sessionToken });

      const appendPromise = session.append({ text: "retry 503" });

      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);

      await expect(appendPromise).resolves.toEqual({ seq: 1, deduped: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-retryable append API failures and still releases the queue", async () => {
    const sessionToken = makeTailSessionToken(
      "ses_hard_failure",
      "agent:writer"
    );

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "invalid_event",
            message: "payload rejected",
          }),
          { status: 400, statusText: "Bad Request" }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ seq: 2, last_seq: 2, deduped: false }), {
          status: 201,
        })
      );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = await starcite.session({ token: sessionToken });

    const firstAppend = session.append({ text: "bad payload" });
    const secondAppend = session.append({ text: "still send next" });

    await expect(firstAppend).rejects.toBeInstanceOf(StarciteApiError);
    await expect(secondAppend).resolves.toEqual({ seq: 2, deduped: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBodies = fetchMock.mock.calls.map((call) => {
      return JSON.parse((call[1] as RequestInit).body as string) as {
        producer_seq: number;
      };
    });

    expect(requestBodies.map((body) => body.producer_seq)).toEqual([1, 2]);
  });

  it("aborts a retrying append and lets later queued appends proceed", async () => {
    vi.useFakeTimers();

    try {
      const sessionToken = makeTailSessionToken(
        "ses_abort_retry",
        "agent:writer"
      );
      const abortController = new AbortController();

      fetchMock.mockImplementation((url, init) => {
        expect(url).toBe(
          "http://localhost:4000/v1/sessions/ses_abort_retry/append"
        );
        const requestInit = init as RequestInit;
        const body = JSON.parse(requestInit.body as string) as {
          producer_seq: number;
        };

        if (body.producer_seq === 1) {
          throw new Error("temporary network failure");
        }

        return new Response(
          JSON.stringify({
            seq: body.producer_seq,
            last_seq: body.producer_seq,
            deduped: false,
          }),
          { status: 201 }
        );
      });

      const starcite = new Starcite({
        baseUrl: "http://localhost:4000",
        fetch: fetchMock,
      });
      const session = await starcite.session({ token: sessionToken });

      const firstAppend = session.append(
        { text: "cancel me" },
        { signal: abortController.signal }
      );
      const secondAppend = session.append({ text: "send after abort" });

      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      abortController.abort();
      await vi.advanceTimersByTimeAsync(250);

      await expect(firstAppend).rejects.toThrow("append() aborted");
      await expect(secondAppend).resolves.toEqual({ seq: 2, deduped: false });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requestBodies = fetchMock.mock.calls.map((call) => {
        return JSON.parse((call[1] as RequestInit).body as string) as {
          producer_seq: number;
        };
      });

      expect(requestBodies.map((body) => body.producer_seq)).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
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

  it("session({ identity, id }) creates missing sessions before minting a token", async () => {
    const apiKey = makeApiKey({
      iss: "https://starcite.ai",
      tenant_id: "tenant-a",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ses_demo",
          title: null,
          metadata: {},
          last_seq: 0,
          created_at: "2026-02-11T00:00:00Z",
          updated_at: "2026-02-11T00:00:00Z",
        }),
        { status: 201 }
      )
    );
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

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://tenant-a.starcite.io/v1/sessions",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://starcite.ai/api/v1/session-tokens",
      expect.objectContaining({
        method: "POST",
      })
    );

    const createRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const createBody = JSON.parse(createRequest.body as string);
    expect(createBody).toEqual({
      id: "ses_demo",
      creator_principal: {
        tenant_id: "tenant-a",
        id: "user-42",
        type: "user",
      },
    });
  });

  it("session({ identity, id }) binds when create returns conflict", async () => {
    const apiKey = makeApiKey({
      iss: "https://starcite.ai",
      tenant_id: "tenant-a",
    });

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "session_exists",
            message: "Session already exists",
          }),
          { status: 409, statusText: "Conflict" }
        )
      )
      .mockResolvedValueOnce(
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

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://tenant-a.starcite.io/v1/sessions",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
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

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ses_demo",
            title: null,
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
    const session = await starcite.session({
      token: sessionToken,
    });
    expect(session.id).toBe("ses_demo");

    // But agent()/user() require apiKey to infer tenant
    expect(() => starcite.agent({ id: "agent-7" })).toThrowError(StarciteError);
  });

  it("returns session({ token }) synchronously", () => {
    const sessionToken = makeTailSessionToken("ses_sync", "agent:syncer");
    const starcite = new Starcite({
      baseUrl: "https://tenant-a.starcite.io",
      fetch: fetchMock,
    });

    const session = starcite.session({ token: sessionToken });

    expect(session).not.toBeInstanceOf(Promise);
    expect(session.id).toBe("ses_sync");
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

    const events: TailEvent[] = [];

    const tailDone = (async () => {
      for await (const { event } of session.tail({
        agent: "drafter",
        cursor: 0,
      })) {
        events.push(event);
      }
    })();
    await waitForSocketCount(sockets, 1);

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

    await waitForValues(events, 1);
    expect(events[0]).toMatchObject({
      seq: 2,
      actor: "agent:drafter",
      payload: { text: "Drafting clause 4.2..." },
    });

    sockets[0]?.emit("close", { code: 1000 });
    await expect(tailDone).resolves.toBeUndefined();
    expect(sockets[0]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0"
      )
    );
  });

  it("tails batched frames and appends batch_size query param", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const events: TailEvent[] = [];

    const tailDone = (async () => {
      for await (const { event } of session.tail({
        cursor: 0,
        batchSize: 2,
      })) {
        events.push(event);
      }
    })();
    await waitForSocketCount(sockets, 1);

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

    await waitForValues(events, 2);
    expect(events[0]).toMatchObject({ seq: 1 });
    expect(events[1]).toMatchObject({ seq: 2 });

    sockets[0]?.emit("close", { code: 1000 });
    await expect(tailDone).resolves.toBeUndefined();
    expect(sockets[0]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0&batch_size=2"
      )
    );
  });

  it("tails ordered events from batched frames without loss", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const events: TailEvent[] = [];

    const tailDone = (async () => {
      for await (const { event } of session.tail({
        cursor: 0,
        batchSize: 2,
      })) {
        events.push(event);
      }
    })();
    await waitForSocketCount(sockets, 1);

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

    await waitForValues(events, 2);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);

    sockets[0]?.emit("close", { code: 1000 });
    await expect(tailDone).resolves.toBeUndefined();
  });

  it("tails events for batched ingestion", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const events: TailEvent[] = [];

    const tailDone = (async () => {
      for await (const { event } of session.tail({
        cursor: 0,
        batchSize: 2,
      })) {
        events.push(event);
      }
    })();
    await waitForSocketCount(sockets, 1);

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

    await waitForValues(events, 2);
    expect(events).toMatchObject([
      { seq: 1, actor: "agent:drafter", payload: { text: "Draft one" } },
      { seq: 2, actor: "agent:drafter", payload: { text: "Draft two" } },
    ]);

    sockets[0]?.emit("close", { code: 1000 });
    await expect(tailDone).resolves.toBeUndefined();
  });

  it("uses query-token websocket auth even when apiKey is set", async () => {
    const sockets: FakeWebSocket[] = [];
    const websocketFactory = vi.fn((url: string) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    });

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: makeApiKey(),
      websocketFactory,
    });

    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const tailDone = Array.fromAsync(session.tail());
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1000 });

    await expect(tailDone).resolves.toEqual([]);
    expect(websocketFactory).toHaveBeenCalledWith(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0&access_token="
      )
    );
  });

  it("sends only a URL argument to custom websocket factories", async () => {
    const sockets: FakeWebSocket[] = [];
    const websocketFactory = vi.fn((url: string) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    });

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey: makeApiKey(),
      websocketFactory,
    });

    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const tailDone = Array.fromAsync(session.tail());
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1000 });

    await expect(tailDone).resolves.toEqual([]);

    expect(websocketFactory).toHaveBeenCalledWith(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0&access_token="
      )
    );
  });

  it("throws a token-expired connection error on close code 4001", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const tailDone = Array.fromAsync(session.tail());
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 4001, reason: "token_expired" });

    const error = await tailDone.catch((err) => err);
    expect(error).toBeInstanceOf(StarciteTokenExpiredError);
    expect((error as Error).message).toContain("token expired");
  });

  it("reconnects on abnormal close and resumes from the last observed seq", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const events: TailEvent[] = [];

    const tailDone = (async () => {
      for await (const { event } of session.tail({
        cursor: 0,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
        },
      })) {
        events.push(event);
      }
    })();
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

    await waitForValues(events, 1);
    expect(events[0]?.seq).toBe(1);

    sockets[0]?.emit("close", { code: 1006, reason: "upstream reset" });

    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=1"
      )
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

    await waitForValues(events, 2);
    expect(events[1]?.seq).toBe(2);

    sockets[1]?.emit("close", { code: 1000 });

    await expect(tailDone).resolves.toBeUndefined();
  });

  it("resumes from the latest seq in a batched frame after reconnect", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const events: TailEvent[] = [];

    const tailDone = (async () => {
      for await (const { event } of session.tail({
        cursor: 0,
        batchSize: 2,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
        },
      })) {
        events.push(event);
      }
    })();
    await waitForSocketCount(sockets, 1);

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

    await waitForValues(events, 2);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);

    sockets[0]?.emit("close", { code: 1006, reason: "upstream reset" });

    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=2&batch_size=2"
      )
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

    await waitForValues(events, 3);
    expect(events[2]?.seq).toBe(3);

    sockets[1]?.emit("close", { code: 1000 });

    await expect(tailDone).resolves.toBeUndefined();
  });

  it("resumes ingestion from latest observed seq after reconnect", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const events: TailEvent[] = [];

    const tailDone = (async () => {
      for await (const { event } of session.tail({
        cursor: 0,
        batchSize: 2,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
        },
      })) {
        events.push(event);
      }
    })();
    await waitForSocketCount(sockets, 1);

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

    await waitForValues(events, 2);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);

    sockets[0]?.emit("close", { code: 1006, reason: "upstream reset" });

    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=2&batch_size=2"
      )
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

    await waitForValues(events, 3);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);

    sockets[1]?.emit("close", { code: 1000 });
    await expect(tailDone).resolves.toBeUndefined();
  });

  it("keeps reconnecting until the transport recovers", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const events: TailEvent[] = [];

    const tailDone = (async () => {
      for await (const { event } of session.tail({
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
        },
      })) {
        events.push(event);
      }
    })();
    await waitForSocketCount(sockets, 1);

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

    await waitForValues(events, 1);
    expect(events[0]?.seq).toBe(1);

    sockets[2]?.emit("close", { code: 1000 });

    await expect(tailDone).resolves.toBeUndefined();
  });

  it("fails when reconnectPolicy maxAttempts is exceeded", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const tailDone = Array.fromAsync(
      session.tail({
        reconnect: true,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
          maxAttempts: 1,
        },
      })
    );
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1006, reason: "deployment restart" });
    await waitForSocketCount(sockets, 2);
    sockets[1]?.emit("close", { code: 1006, reason: "network still down" });

    await expect(tailDone).rejects.toBeInstanceOf(StarciteRetryLimitError);

    await tailDone.catch((error) => {
      const tailError = error as StarciteRetryLimitError;
      expect(tailError.stage).toBe("retry_limit");
      expect(tailError.sessionId).toBe("ses_tail");
      expect(tailError.closeCode).toBe(1006);
    });
  });

  it("supports zero reconnect attempts via reconnectPolicy", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const tailDone = Array.fromAsync(
      session.tail({
        reconnect: true,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 0,
          maxAttempts: 0,
        },
      })
    );
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1006, reason: "deployment restart" });

    await expect(tailDone).rejects.toBeInstanceOf(StarciteRetryLimitError);
    await tailDone.catch((error) => {
      const tailError = error as StarciteRetryLimitError;
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

    const tailDone = Array.fromAsync(
      session.tail({
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
    );
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("close", { code: 1006, reason: "deployment restart" });
    await expect(tailDone).rejects.toBeInstanceOf(StarciteTailError);

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

  it("propagates lifecycle callback exceptions", async () => {
    const { starcite } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const tailDone = Array.fromAsync(
      session.tail({
        reconnect: false,
        onLifecycleEvent: () => {
          throw new Error("observer failure");
        },
      })
    );

    await expect(tailDone).rejects.toThrow("observer failure");
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

    const tailDone = Array.fromAsync(session.tail());
    await waitForSocketCount(sockets, 1);

    sockets[0]?.emit("message", { data: "not json" });

    await expect(tailDone).rejects.toBeInstanceOf(StarciteConnectionError);
  });

  it("fails fast when the tail consumer falls behind buffered batches", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });
    const events: TailEvent[] = [];
    let releaseFirstEvent: (() => void) | undefined;
    const firstEventGate = new Promise<void>((resolve) => {
      releaseFirstEvent = resolve;
    });

    let callbackInvocations = 0;
    const tailDone = (async () => {
      for await (const { event } of session.tail({
        cursor: 0,
        reconnect: false,
        maxBufferedBatches: 1,
      })) {
        events.push(event);
        callbackInvocations += 1;

        if (callbackInvocations === 1) {
          // Keep the first callback pending so later frames accumulate and
          // trigger the stream's buffered-batch backpressure guard.
          await firstEventGate;
        }
      }
    })();

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

    releaseFirstEvent?.();

    await expect(tailDone).rejects.toBeInstanceOf(StarciteBackpressureError);
    expect(events[0]?.seq).toBe(1);
    await tailDone.catch((error) => {
      const tailError = error as StarciteBackpressureError;
      expect(tailError.stage).toBe("consumer_backpressure");
      expect(tailError.sessionId).toBe("ses_tail");
    });
  });

  it("syncs session snapshot updates via on('event')", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });
    const observedSeqs: number[] = [];

    const unsubscribe = session.on("event", (event) => {
      observedSeqs.push(event.seq);
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

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observedSeqs).toEqual([1, 2]);
    expect(session.state()).toMatchObject({
      lastSeq: 2,
      syncing: true,
    });
    expect(session.state().events.map((event) => event.seq)).toEqual([1, 2]);

    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.state().syncing).toBe(false);
  });

  it("deduplicates identical repeated events in session snapshot", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });
    const observedSeqs: number[] = [];

    const unsubscribe = session.on("event", (event) => {
      observedSeqs.push(event.seq);
    });

    await waitForSocketCount(sockets, 1);

    const repeatedEvent = {
      seq: 1,
      type: "content",
      payload: { text: "first frame" },
      actor: "agent:drafter",
      producer_id: "producer:drafter",
      producer_seq: 1,
    };

    sockets[0]?.emit("message", { data: JSON.stringify(repeatedEvent) });
    sockets[0]?.emit("message", { data: JSON.stringify(repeatedEvent) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observedSeqs).toEqual([1]);
    expect(session.state().events.map((event) => event.seq)).toEqual([1]);
    unsubscribe();
  });

  it("hydrates session.log from SessionStore persisted state", async () => {
    const sockets: FakeWebSocket[] = [];
    const persistedBySession = new Map<
      string,
      { cursor: number; events: TailEvent[] }
    >();
    const store = {
      load(sessionId: string) {
        return persistedBySession.get(sessionId);
      },
      save(
        sessionId: string,
        state: {
          cursor: number;
          events: TailEvent[];
        }
      ) {
        persistedBySession.set(sessionId, {
          cursor: state.cursor,
          events: [...state.events],
        });
      },
    };

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      store,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const sessionToken = makeTailSessionToken();
    const firstSession = await starcite.session({ token: sessionToken });
    const unsubscribe = firstSession.on("event", () => undefined);

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
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();
    firstSession.disconnect();

    const secondSession = await starcite.session({ token: sessionToken });
    expect(secondSession.log.cursor).toBe(2);
    expect(secondSession.log.events.map((event) => event.seq)).toEqual([1, 2]);

    const replayedSeqs: number[] = [];
    const stopReplay = secondSession.on("event", (event) => {
      replayedSeqs.push(event.seq);
    });
    expect(replayedSeqs).toEqual([1, 2]);
    stopReplay();
    secondSession.disconnect();
  });

  it("ignores corrupt persisted session state and clears the cache", async () => {
    const sockets: FakeWebSocket[] = [];
    const clearStore = vi.fn();
    const store = {
      load() {
        return {
          cursor: 1,
          events: [
            {
              seq: 2,
              type: "content",
              payload: { text: "corrupt cached frame" },
              actor: "agent:drafter",
              producer_id: "producer:drafter",
              producer_seq: 2,
            },
          ],
        };
      },
      save() {
        return;
      },
      clear: clearStore,
    };

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      store,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const session = await starcite.session({ token: makeTailSessionToken() });

    expect(session.log.cursor).toBe(0);
    expect(session.log.events).toEqual([]);
    expect(clearStore).toHaveBeenCalledWith("ses_tail");

    session.on("event", () => undefined);
    await waitForSocketCount(sockets, 1);
    expect(sockets[0]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0"
      )
    );

    session.disconnect();
  });

  it("continues live sync when session store save fails", async () => {
    const sockets: FakeWebSocket[] = [];
    let shouldFailSave = true;
    const saveStore = vi.fn(() => {
      if (shouldFailSave) {
        shouldFailSave = false;
        throw new Error("quota exceeded");
      }
    });
    const store = {
      load() {
        return undefined;
      },
      save: saveStore,
    };

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      store,
      websocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const session = await starcite.session({ token: makeTailSessionToken() });
    const observedSeqs: number[] = [];
    const syncErrors: Error[] = [];

    session.on("error", (error) => {
      syncErrors.push(error);
    });
    session.on("event", (event) => {
      observedSeqs.push(event.seq);
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

    await waitForValues(observedSeqs, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observedSeqs).toEqual([1, 2]);
    expect(syncErrors).toHaveLength(1);
    expect(syncErrors[0]?.message).toContain("Session store save failed");
    expect(saveStore).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);

    session.disconnect();
  });

  it("marks cold-start catch-up events as replay before switching to live", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const session = await starcite.session({ token: makeTailSessionToken() });

    const observed: Array<{
      seq: number;
      phase: "replay" | "live";
      replayed: boolean;
    }> = [];

    session.on("event", (event, context) => {
      observed.push({
        seq: event.seq,
        phase: context.phase,
        replayed: context.replayed,
      });
    });

    await waitForSocketCount(sockets, 1);
    expect(sockets[0]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0"
      )
    );

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 1,
        type: "chat.user.message",
        payload: { parts: [{ type: "text", text: "older prompt" }] },
        actor: "user:alice",
        producer_id: "producer:alice",
        producer_seq: 1,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 2,
        type: "chat.user.message",
        payload: { parts: [{ type: "text", text: "newer prompt" }] },
        actor: "user:alice",
        producer_id: "producer:alice",
        producer_seq: 2,
      }),
    });

    await waitForValues(observed, 2);
    expect(observed[0]).toMatchObject({
      seq: 1,
      phase: "replay",
      replayed: true,
    });
    expect(observed[1]).toMatchObject({
      seq: 2,
      phase: "replay",
      replayed: true,
    });

    sockets[0]?.emit("close", { code: 1000, reason: "caught up" });
    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=2"
      )
    );

    sockets[1]?.emit("message", {
      data: JSON.stringify({
        seq: 3,
        type: "chat.user.message",
        payload: { parts: [{ type: "text", text: "live prompt" }] },
        actor: "user:alice",
        producer_id: "producer:alice",
        producer_seq: 3,
      }),
    });

    await waitForValues(observed, 3);
    expect(observed[2]).toMatchObject({
      seq: 3,
      phase: "live",
      replayed: false,
    });

    session.disconnect();
  });

  it("replays retained events to late session listeners", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const session = await starcite.session({ token: makeTailSessionToken() });

    const firstListenerSeqs: number[] = [];
    const secondListenerSeqs: number[] = [];

    session.on("event", (event) => {
      firstListenerSeqs.push(event.seq);
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    session.on("event", (event) => {
      secondListenerSeqs.push(event.seq);
    });

    expect(secondListenerSeqs).toEqual([1, 2]);
    expect(firstListenerSeqs).toEqual([1, 2]);
    session.disconnect();
  });

  it("recovers from session log gaps by reconnecting from the last applied seq", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const session = await starcite.session({ token: makeTailSessionToken() });
    const observedSeqs: number[] = [];

    session.on("event", (event) => {
      observedSeqs.push(event.seq);
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
        seq: 3,
        type: "content",
        payload: { text: "gap frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 3,
      }),
    });

    await waitForSocketCount(sockets, 2);
    expect(sockets[1]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=1"
      )
    );

    sockets[1]?.emit("message", {
      data: JSON.stringify({
        seq: 2,
        type: "content",
        payload: { text: "second frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 2,
      }),
    });
    sockets[1]?.emit("message", {
      data: JSON.stringify({
        seq: 3,
        type: "content",
        payload: { text: "third frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 3,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observedSeqs).toEqual([1, 2, 3]);
    session.disconnect();
  });

  it("routes fatal live-sync failures to on('error') listeners", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const session = await starcite.session({ token: makeTailSessionToken() });
    const syncErrors: Error[] = [];

    session.on("error", (error) => {
      syncErrors.push(error);
    });
    session.on("event", () => undefined);

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
        seq: 1,
        type: "content",
        payload: { text: "conflict frame" },
        actor: "agent:drafter",
        producer_id: "producer:other",
        producer_seq: 99,
      }),
    });
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (syncErrors.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(syncErrors).toHaveLength(1);
    expect(syncErrors[0]).toBeInstanceOf(StarciteError);
    expect(syncErrors[0]?.message).toContain("Session log conflict for seq 1");
    session.disconnect();
  });

  it("retries live sync after non-gap catch-up failures", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const session = await starcite.session({ token: makeTailSessionToken() });
    const observedSeqs: number[] = [];
    const syncErrors: Error[] = [];

    session.on("error", (error) => {
      syncErrors.push(error);
    });
    session.on("event", (event) => {
      observedSeqs.push(event.seq);
    });

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("close", { code: 1006, reason: "dial failed" });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (sockets.length >= 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(syncErrors).toHaveLength(1);

    sockets[1]?.emit("message", {
      data: JSON.stringify({
        seq: 1,
        type: "content",
        payload: { text: "recovered frame" },
        actor: "agent:drafter",
        producer_id: "producer:drafter",
        producer_seq: 1,
      }),
    });

    await waitForValues(observedSeqs, 1);
    expect(observedSeqs).toEqual([1]);
    session.disconnect();
  });

  it("restarts live sync if listeners return while teardown is in flight", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const session = await starcite.session({ token: makeTailSessionToken() });

    const firstUnsubscribe = session.on("event", () => undefined);
    await waitForSocketCount(sockets, 1);

    firstUnsubscribe();
    session.on("event", () => undefined);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (sockets.length >= 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    session.disconnect();
  });

  it("applies log retention limits in session snapshot", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({
      token: sessionToken,
      logOptions: { maxEvents: 2 },
    });

    const unsubscribe = session.on("event", () => undefined);
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

    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = session.state();
    expect(snapshot.lastSeq).toBe(3);
    expect(snapshot.events.map((event) => event.seq)).toEqual([2, 3]);
    unsubscribe();
    session.disconnect();
  });

  it("ignores duplicates that are older than retained log history", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const session = await starcite.session({
      token: makeTailSessionToken(),
      logOptions: { maxEvents: 2 },
    });
    const observedSeqs: number[] = [];
    const syncErrors: Error[] = [];

    session.on("error", (error) => {
      syncErrors.push(error);
    });
    session.on("event", (event) => {
      observedSeqs.push(event.seq);
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
    await new Promise((resolve) => setTimeout(resolve, 0));

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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state().events.map((event) => event.seq)).toEqual([2, 3]);
    expect(observedSeqs).toEqual([1, 2, 3]);
    expect(syncErrors).toEqual([]);
    session.disconnect();
  });

  it("does not fail fast when maxBufferedBatches is provided", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const tailDone = Array.fromAsync(session.tail({ maxBufferedBatches: 0 }));
    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("close", { code: 1000 });
    await expect(tailDone).resolves.toEqual([]);
  });

  it("does not fail fast when batchSize is provided", async () => {
    const { starcite, sockets } = buildTailClient(fetchMock);
    const sessionToken = makeTailSessionToken();
    const session = await starcite.session({ token: sessionToken });

    const tailDone = Array.fromAsync(session.tail({ batchSize: 0 }));
    await waitForSocketCount(sockets, 1);
    expect(sockets[0]?.url).toEqual(
      expect.stringContaining(
        "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0&batch_size=0"
      )
    );
    sockets[0]?.emit("close", { code: 1000 });
    await expect(tailDone).resolves.toEqual([]);
  });
});
