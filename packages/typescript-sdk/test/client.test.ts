import { beforeEach, describe, expect, it, vi } from "vitest";
import { Starcite } from "../src/client";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "../src/errors";
import { MemorySessionCache } from "../src/session-cache";

vi.mock("phoenix", () => {
  class MockChannel {
    on(): number {
      return 0;
    }

    off(): void {
      return;
    }

    leave(): void {
      return;
    }

    rejoin(): void {
      return;
    }

    join(): {
      receive: (
        _status: "ok" | "error" | "timeout",
        _callback: () => void
      ) => {
        receive: (
          _nextStatus: "ok" | "error" | "timeout",
          _nextCallback: () => void
        ) => ReturnType<MockChannel["join"]>;
      };
    } {
      return {
        receive: () => this.join(),
      };
    }
  }

  class MockSocket {
    connect(): void {
      return;
    }

    disconnect(): void {
      return;
    }

    isConnected(): boolean {
      return true;
    }

    channel(): MockChannel {
      return new MockChannel();
    }
  }

  return {
    Channel: MockChannel,
    Socket: MockSocket,
  };
});

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

async function waitForCondition(
  predicate: () => boolean,
  description: string
): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for condition: ${description}`);
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
  principalId = "drafter",
  principalType: "agent" | "user" = "agent"
): string {
  return tokenFromClaims({
    session_id: sessionId,
    tenant_id: "test-tenant",
    principal_id: principalId,
    principal_type: principalType,
  });
}

/**
 * Creates an API key JWT with standard claims for client construction tests.
 */
function makeApiKey(overrides: Record<string, unknown> = {}): string {
  return tokenFromClaims({
    iss: "https://starcite.ai",
    tenant_id: "test-tenant",
    principal_id: "system",
    principal_type: "user",
    ...overrides,
  });
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
            token: makeTailSessionToken("ses_1", "researcher"),
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
        source: "agent",
      })
    );
    expect(body.actor).toBeUndefined();
    expect(body.producer_id).toEqual(expect.any(String));
    expect(body.producer_seq).toBe(1);
  });

  it("preserves an explicit actor override when appending", async () => {
    const sessionToken = makeTailSessionToken("ses_actor_override", "writer");

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ seq: 1, last_seq: 1, deduped: false }), {
        status: 201,
      })
    );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = await starcite.session({ token: sessionToken });

    await session.append({
      actor: "agent:researcher",
      payload: { text: "custom actor" },
      type: "custom",
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(requestInit.body as string);

    expect(body.actor).toBe("agent:researcher");
    expect(body.type).toBe("custom");
    expect(body.payload).toEqual({ text: "custom actor" });
  });

  it("uses distinct session-scoped socket managers for identity-backed sessions", async () => {
    const apiKey = makeApiKey();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ses_same",
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
            token: makeTailSessionToken("ses_same", "agent-one"),
            expires_in: 3600,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ses_same",
            title: "Draft",
            metadata: {},
            last_seq: 0,
            created_at: "2026-02-11T00:00:00Z",
            updated_at: "2026-02-11T00:00:00Z",
          }),
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: makeTailSessionToken("ses_same", "agent-two"),
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

    const firstSession = await starcite.session({
      identity: starcite.agent({ id: "agent-one" }),
      id: "ses_same",
    });
    const secondSession = await starcite.session({
      identity: starcite.agent({ id: "agent-two" }),
      id: "ses_same",
    });

    const firstTransport = (
      firstSession as unknown as {
        transport: { bearerToken: string; socketManager: unknown };
      }
    ).transport;
    const secondTransport = (
      secondSession as unknown as {
        transport: { bearerToken: string; socketManager: unknown };
      }
    ).transport;
    const clientSocketManager = (
      starcite as unknown as {
        transport: { socketManager: unknown };
      }
    ).transport.socketManager;

    expect(firstTransport.bearerToken).toBe(
      makeTailSessionToken("ses_same", "agent-one")
    );
    expect(secondTransport.bearerToken).toBe(
      makeTailSessionToken("ses_same", "agent-two")
    );
    expect(firstTransport.socketManager).not.toBe(clientSocketManager);
    expect(secondTransport.socketManager).not.toBe(clientSocketManager);
    expect(firstTransport.socketManager).not.toBe(
      secondTransport.socketManager
    );
  });

  it("serializes concurrent appends for a session producer", async () => {
    const sessionToken = makeTailSessionToken("ses_serial", "writer");
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
      const sessionToken = makeTailSessionToken("ses_retry_append", "writer");

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
      const sessionToken = makeTailSessionToken("ses_append_queue", "writer");
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
        "writer"
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

  it("pauses the queue on non-retryable append failures to preserve producer ordering", async () => {
    const sessionToken = makeTailSessionToken("ses_hard_failure", "writer");
    const lifecycleEvents: string[] = [];

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
    session.on("append", (event) => {
      lifecycleEvents.push(event.type);
    });

    const firstAppend = session.append({ text: "bad payload" });
    const firstAppendResult = firstAppend.catch((error) => error);
    const secondAppend = session.append({ text: "hold queue behind failure" });
    let secondSettled = false;
    secondAppend
      .finally(() => {
        secondSettled = true;
      })
      .catch(() => undefined);

    const firstError = await firstAppendResult;
    expect(firstError).toBeInstanceOf(StarciteApiError);

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.appendState()).toEqual(
      expect.objectContaining({
        status: "paused",
        lastFailure: expect.objectContaining({
          retryable: false,
          terminal: true,
          status: 400,
        }),
      })
    );
    expect(
      session
        .appendState()
        .pending.map((pendingAppend) => pendingAppend.request.producer_seq)
    ).toEqual([1, 2]);
    expect(lifecycleEvents[0]).toBe("queued");
    expect(lifecycleEvents[1]).toBe("attempt_started");
    expect(lifecycleEvents).toContain("paused");

    session.resetAppendQueue();
    await expect(secondAppend).rejects.toThrow("append queue reset");
  });

  it("pauses the queue when an in-flight retrying append is aborted", async () => {
    vi.useFakeTimers();

    try {
      const sessionToken = makeTailSessionToken("ses_abort_retry", "writer");
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
      const firstAppendResult = firstAppend.catch((error) => error);
      const secondAppend = session.append({ text: "send after abort" });
      let secondSettled = false;
      secondAppend
        .finally(() => {
          secondSettled = true;
        })
        .catch(() => undefined);

      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      abortController.abort();
      await vi.advanceTimersByTimeAsync(250);

      const firstError = await firstAppendResult;
      expect(firstError).toBeInstanceOf(StarciteError);
      expect((firstError as Error).message).toContain("append() aborted");
      expect(secondSettled).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(session.appendState()).toEqual(
        expect.objectContaining({
          status: "paused",
          lastFailure: expect.objectContaining({
            retryable: false,
            terminal: true,
          }),
        })
      );

      session.resetAppendQueue();
      await expect(secondAppend).rejects.toThrow("append queue reset");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a paused queue after retry-limit exhaustion and preserves producer ordering", async () => {
    vi.useFakeTimers();

    try {
      const sessionToken = makeTailSessionToken(
        "ses_retry_limit_resume",
        "writer"
      );
      let transientFailureCount = 0;

      fetchMock.mockImplementation((url, init) => {
        expect(url).toBe(
          "http://localhost:4000/v1/sessions/ses_retry_limit_resume/append"
        );
        const requestInit = init as RequestInit;
        const body = JSON.parse(requestInit.body as string) as {
          producer_seq: number;
        };

        if (body.producer_seq === 1 && transientFailureCount < 2) {
          transientFailureCount += 1;
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
      const session = await starcite.session({
        token: sessionToken,
        appendOptions: {
          retryPolicy: {
            maxAttempts: 1,
          },
        },
      });

      const firstAppendResult = session
        .append({ text: "recoverable after pause" })
        .catch((error) => error);
      const secondAppend = session.append({ text: "send after resume" });

      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);

      const firstError = await firstAppendResult;
      expect(firstError).toBeInstanceOf(StarciteConnectionError);
      expect(session.appendState().status).toBe("paused");

      session.resumeAppendQueue();
      await expect(secondAppend).resolves.toEqual({ seq: 2, deduped: false });

      expect(fetchMock).toHaveBeenCalledTimes(4);
      const requestBodies = fetchMock.mock.calls.map((call) => {
        return JSON.parse((call[1] as RequestInit).body as string) as {
          producer_seq: number;
        };
      });

      expect(requestBodies.map((body) => body.producer_seq)).toEqual([
        1, 1, 1, 2,
      ]);
      expect(session.appendState()).toEqual(
        expect.objectContaining({
          status: "idle",
          lastAcknowledgedProducerSeq: 2,
          pending: [],
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores persisted pending appends from the session cache and auto-flushes them", async () => {
    const sessionToken = makeTailSessionToken("ses_persisted_outbox", "writer");
    const cache = new MemorySessionCache();
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      cache,
    });
    const session = await starcite.session({
      token: sessionToken,
      appendOptions: {
        autoFlush: false,
      },
    });

    const queuedAppend = session.append({ text: "persist me" });
    queuedAppend.catch(() => undefined);

    const cachedBeforeRestore = cache.read("ses_persisted_outbox");
    const persistedProducerId = cachedBeforeRestore?.outbox?.producerId;
    expect(cachedBeforeRestore?.outbox?.pending).toHaveLength(1);
    expect(cachedBeforeRestore?.outbox?.pending[0]?.request.producer_seq).toBe(
      1
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ seq: 1, last_seq: 1, deduped: false }), {
        status: 201,
      })
    );

    const restoredClient = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      cache,
    });
    const restoredSession = await restoredClient.session({
      token: sessionToken,
    });

    await waitForValues(fetchMock.mock.calls, 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const restoredBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string
    ) as { producer_id: string; producer_seq: number };
    expect(restoredBody).toEqual(
      expect.objectContaining({
        producer_id: persistedProducerId,
        producer_seq: 1,
      })
    );
    await waitForCondition(() => {
      return cache.read("ses_persisted_outbox")?.outbox?.pending.length === 0;
    }, "persisted append queue to flush");
    expect(cache.read("ses_persisted_outbox")?.outbox?.pending).toHaveLength(0);
    expect(restoredSession.appendState()).toEqual(
      expect.objectContaining({
        status: "idle",
        lastAcknowledgedProducerSeq: 1,
        pending: [],
      })
    );
  });

  it("reconciles restored pending appends against retained committed events before auto-flush", async () => {
    const sessionToken = makeTailSessionToken(
      "ses_reconciled_outbox",
      "writer"
    );
    const cache = new MemorySessionCache();
    const producerId = crypto.randomUUID();

    cache.write("ses_reconciled_outbox", {
      log: {
        cursor: 1,
        lastSeq: 1,
        events: [
          {
            seq: 1,
            cursor: 1,
            type: "content",
            payload: { text: "persist me" },
            actor: "agent:writer",
            producer_id: producerId,
            producer_seq: 1,
            idempotency_key: "persisted-append",
          },
        ],
      },
      outbox: {
        producerId,
        lastAcknowledgedProducerSeq: 0,
        pending: [
          {
            id: "pending-1",
            request: {
              type: "content",
              payload: { text: "persist me" },
              producer_id: producerId,
              producer_seq: 1,
              source: "agent",
              idempotency_key: "persisted-append",
            },
            enqueuedAtMs: Date.now(),
            retryAttempt: 0,
          },
        ],
        status: "idle",
      },
    });

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      cache,
    });
    const restoredSession = await starcite.session({
      token: sessionToken,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(restoredSession.appendState()).toEqual(
      expect.objectContaining({
        status: "idle",
        lastAcknowledgedProducerSeq: 1,
        pending: [],
      })
    );
    expect(restoredSession.state()).toEqual(
      expect.objectContaining({
        append: expect.objectContaining({
          status: "idle",
          lastAcknowledgedProducerSeq: 1,
          pending: [],
        }),
      })
    );
    expect(cache.read("ses_reconciled_outbox")?.outbox).toEqual(
      expect.objectContaining({
        lastAcknowledgedProducerSeq: 1,
        pending: [],
      })
    );
  });

  it("restores a terminally paused outbox without auto-flushing it again", async () => {
    const sessionToken = makeTailSessionToken("ses_persisted_pause", "writer");
    const cache = new MemorySessionCache();

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "invalid_event",
          message: "payload rejected",
        }),
        { status: 400, statusText: "Bad Request" }
      )
    );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      cache,
    });
    const session = await starcite.session({ token: sessionToken });
    const firstAppendResult = session
      .append({ text: "bad payload" })
      .catch((error) => error);

    const firstError = await firstAppendResult;
    expect(firstError).toBeInstanceOf(StarciteApiError);
    expect(session.appendState().status).toBe("paused");
    expect(cache.read("ses_persisted_pause")?.outbox?.status).toBe("paused");

    fetchMock.mockClear();

    const restoredClient = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      cache,
    });
    const restoredSession = await restoredClient.session({
      token: sessionToken,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(restoredSession.appendState()).toEqual(
      expect.objectContaining({
        status: "paused",
        pending: [
          expect.objectContaining({
            request: expect.objectContaining({
              producer_seq: 1,
            }),
          }),
        ],
      })
    );
  });

  it("clears the outbox and rotates the managed producer when configured for terminal clear mode", async () => {
    const sessionToken = makeTailSessionToken("ses_clear_mode", "writer");

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "invalid_event",
          message: "payload rejected",
        }),
        { status: 400, statusText: "Bad Request" }
      )
    );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });
    const session = await starcite.session({
      token: sessionToken,
      appendOptions: {
        terminalFailureMode: "clear",
      },
    });
    const initialProducerId = session.appendState().producerId;

    const firstAppendResult = session
      .append({ text: "bad payload" })
      .catch((error) => error);
    const secondAppendResult = session
      .append({ text: "drop queued payload" })
      .catch((error) => error);

    const firstError = await firstAppendResult;
    const secondError = await secondAppendResult;

    expect(firstError).toBeInstanceOf(StarciteApiError);
    expect(secondError).toBeInstanceOf(StarciteApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.appendState()).toEqual(
      expect.objectContaining({
        status: "idle",
        pending: [],
        lastAcknowledgedProducerSeq: 0,
        lastFailure: expect.objectContaining({
          terminal: true,
          status: 400,
        }),
      })
    );
    expect(session.appendState().producerId).not.toBe(initialProducerId);
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
    const sessionToken = makeTailSessionToken("ses_demo", "user-42", "user");
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
    const sessionToken = makeTailSessionToken("ses_sync", "syncer");
    const starcite = new Starcite({
      baseUrl: "https://tenant-a.starcite.io",
      fetch: fetchMock,
    });

    const session = starcite.session({ token: sessionToken });

    expect(session).not.toBeInstanceOf(Promise);
    expect(session.id).toBe("ses_sync");
  });

  it("refreshes expired session tokens before retrying queued appends", async () => {
    const sessionToken = makeTailSessionToken("ses_refresh_append", "writer");
    const refreshedToken = makeTailSessionToken(
      "ses_refresh_append",
      "writer-refreshed"
    );
    const authHeaders: Array<string | null> = [];
    const refreshToken = vi.fn().mockResolvedValue(refreshedToken);

    fetchMock
      .mockImplementationOnce((_url, init) => {
        authHeaders.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "token_expired",
              message: "session token expired",
            }),
            { status: 401, statusText: "Unauthorized" }
          )
        );
      })
      .mockImplementationOnce((_url, init) => {
        authHeaders.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          new Response(
            JSON.stringify({ seq: 1, last_seq: 1, deduped: false }),
            { status: 201 }
          )
        );
      });

    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    }).session({
      token: sessionToken,
      refreshToken,
    });

    await expect(
      session.append({ text: "retry after reauth" })
    ).resolves.toEqual({
      deduped: false,
      seq: 1,
    });

    expect(refreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "unauthorized",
        sessionId: "ses_refresh_append",
        token: sessionToken,
      })
    );
    expect(authHeaders).toEqual([
      `Bearer ${sessionToken}`,
      `Bearer ${refreshedToken}`,
    ]);
    expect(session.appendState()).toEqual(
      expect.objectContaining({
        pending: [],
        status: "idle",
      })
    );
    expect(session.token).toBe(refreshedToken);
    expect(session.identity.id).toBe("writer-refreshed");
  });

  it("rebinds future appends after a manual refreshAuth call", async () => {
    const sessionToken = makeTailSessionToken("ses_manual_refresh", "writer");
    const refreshedToken = tokenFromClaims({
      refreshed: true,
      session_id: "ses_manual_refresh",
      tenant_id: "test-tenant",
      principal_id: "writer",
      principal_type: "agent",
    });
    const authHeaders: Array<string | null> = [];
    const refreshToken = vi.fn().mockResolvedValue(refreshedToken);

    fetchMock.mockImplementationOnce((_url, init) => {
      authHeaders.push(new Headers(init?.headers).get("authorization"));
      return Promise.resolve(
        new Response(JSON.stringify({ seq: 1, last_seq: 1, deduped: false }), {
          status: 201,
        })
      );
    });

    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    }).session({
      token: sessionToken,
      refreshToken,
    });

    await expect(session.refreshAuth()).resolves.toBeUndefined();
    await expect(
      session.append({ text: "after manual refresh" })
    ).resolves.toEqual({
      deduped: false,
      seq: 1,
    });

    expect(refreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "manual",
        sessionId: "ses_manual_refresh",
        token: sessionToken,
      })
    );
    expect(authHeaders).toEqual([`Bearer ${refreshedToken}`]);
    expect(session.token).toBe(refreshedToken);
  });

  it("shares one token refresh across queued appends behind an auth failure", async () => {
    const sessionToken = makeTailSessionToken("ses_shared_refresh", "writer");
    const refreshedToken = makeTailSessionToken(
      "ses_shared_refresh",
      "writer-refreshed"
    );
    const authHeaders: Array<string | null> = [];
    const refreshToken = vi.fn().mockResolvedValue(refreshedToken);

    fetchMock
      .mockImplementationOnce((_url, init) => {
        authHeaders.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "token_expired",
              message: "session token expired",
            }),
            { status: 401, statusText: "Unauthorized" }
          )
        );
      })
      .mockImplementationOnce((_url, init) => {
        authHeaders.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          new Response(
            JSON.stringify({ seq: 1, last_seq: 1, deduped: false }),
            { status: 201 }
          )
        );
      })
      .mockImplementationOnce((_url, init) => {
        authHeaders.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          new Response(
            JSON.stringify({ seq: 2, last_seq: 2, deduped: false }),
            { status: 201 }
          )
        );
      });

    const session = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    }).session({
      token: sessionToken,
      refreshToken,
    });

    const firstAppend = session.append({ text: "first after refresh" });
    const secondAppend = session.append({ text: "second after refresh" });

    await expect(firstAppend).resolves.toEqual({
      deduped: false,
      seq: 1,
    });
    await expect(secondAppend).resolves.toEqual({
      deduped: false,
      seq: 2,
    });

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(authHeaders).toEqual([
      `Bearer ${sessionToken}`,
      `Bearer ${refreshedToken}`,
      `Bearer ${refreshedToken}`,
    ]);
    expect(session.appendState()).toEqual(
      expect.objectContaining({
        pending: [],
        status: "idle",
      })
    );
  });

  it("uses the default identity-backed refresh handler for manual refreshAuth", async () => {
    const apiKey = makeApiKey({
      iss: "https://starcite.ai",
      tenant_id: "tenant-a",
    });
    const initialToken = tokenFromClaims({
      session_id: "ses_identity_refresh",
      tenant_id: "tenant-a",
      principal_id: "planner",
      principal_type: "agent",
    });
    const refreshedToken = tokenFromClaims({
      refreshed: true,
      session_id: "ses_identity_refresh",
      tenant_id: "tenant-a",
      principal_id: "planner",
      principal_type: "agent",
    });

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ses_identity_refresh",
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
          JSON.stringify({ token: initialToken, expires_in: 3600 }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: refreshedToken, expires_in: 3600 }),
          { status: 200 }
        )
      );

    const starcite = new Starcite({
      baseUrl: "https://tenant-a.starcite.io",
      fetch: fetchMock,
      apiKey,
    });
    const session = await starcite.session({
      identity: starcite.agent({ id: "planner" }),
      id: "ses_identity_refresh",
    });

    await expect(session.refreshAuth()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://starcite.ai/api/v1/session-tokens",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://starcite.ai/api/v1/session-tokens",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(session.token).toBe(refreshedToken);
    expect(session.identity.id).toBe("planner");
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

  it("serializes archived session filters on list requests", async () => {
    fetchMock.mockImplementation(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            sessions: [],
            next_cursor: null,
          }),
          { status: 200 }
        )
      );
    });

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    await starcite.listSessions({
      limit: 10,
      cursor: "ses_cursor",
      archived: true,
      metadata: { workflow: "planner" },
    });
    await starcite.listSessions({ archived: "all" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/v1/sessions?limit=10&cursor=ses_cursor&archived=true&metadata.workflow=planner",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:4000/v1/sessions?archived=all",
      expect.objectContaining({
        method: "GET",
      })
    );
  });

  it("fetches a session header by id", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ses_lookup",
          title: "Archived draft",
          metadata: { workflow: "planner" },
          archived: true,
          tenant_id: "tenant-alpha",
          creator_principal: {
            tenant_id: "tenant-alpha",
            id: "system",
            type: "service",
          },
          created_at: "2026-04-08T13:20:00Z",
          updated_at: "2026-04-08T13:25:00Z",
          version: 3,
        }),
        { status: 200 }
      )
    );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    const session = await starcite.getSession("ses_lookup");

    expect(session).toMatchObject({
      id: "ses_lookup",
      archived: true,
      tenant_id: "tenant-alpha",
      version: 3,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/v1/sessions/ses_lookup",
      expect.objectContaining({
        method: "GET",
      })
    );
  });

  it("patches session headers with expected_version", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ses_patch",
          title: "Final",
          metadata: {
            workflow: "contract",
            summary: "Generated",
          },
          last_seq: 0,
          archived: false,
          created_at: "2026-04-08T13:20:00Z",
          updated_at: "2026-04-08T13:45:00Z",
          version: 2,
        }),
        { status: 200 }
      )
    );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    const session = await starcite.updateSession("ses_patch", {
      title: "Final",
      metadata: { summary: "Generated" },
      expectedVersion: 1,
    });

    expect(session).toMatchObject({
      id: "ses_patch",
      title: "Final",
      version: 2,
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/v1/sessions/ses_patch"
    );
    expect(requestInit.method).toBe("PATCH");
    expect(JSON.parse(requestInit.body as string)).toEqual({
      title: "Final",
      metadata: { summary: "Generated" },
      expected_version: 1,
    });
  });

  it("archives and unarchives sessions through dedicated endpoints", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ses_archive",
            title: "Archived",
            metadata: {},
            last_seq: 0,
            archived: true,
            created_at: "2026-04-08T13:20:00Z",
            updated_at: "2026-04-08T13:50:00Z",
            version: 2,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ses_archive",
            title: "Archived",
            metadata: {},
            last_seq: 0,
            archived: false,
            created_at: "2026-04-08T13:20:00Z",
            updated_at: "2026-04-08T13:51:00Z",
            version: 3,
          }),
          { status: 200 }
        )
      );

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
    });

    const archived = await starcite.archiveSession("ses_archive");
    const unarchived = await starcite.unarchiveSession("ses_archive");

    expect(archived.archived).toBe(true);
    expect(unarchived.archived).toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/v1/sessions/ses_archive/archive"
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://localhost:4000/v1/sessions/ses_archive/unarchive"
    );
    expect(
      fetchMock.mock.calls.map((call) => {
        const requestInit = call[1] as RequestInit;
        return {
          body: JSON.parse(requestInit.body as string),
          method: requestInit.method,
        };
      })
    ).toEqual([
      { method: "POST", body: {} },
      { method: "POST", body: {} },
    ]);
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
            token: makeTailSessionToken("ses_auth_claims", "planner"),
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

  it("accepts actor-style principal_id claims in api keys", () => {
    const apiKey = makeApiKey({
      tenant_id: "tenant-alpha",
      principal_id: "user:system",
      principal_type: "agent",
    });

    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      apiKey,
    });

    expect(starcite.agent({ id: "planner" }).toCreatorPrincipal()).toEqual({
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
            token: makeTailSessionToken("ses_org_subject", "foo"),
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
});
