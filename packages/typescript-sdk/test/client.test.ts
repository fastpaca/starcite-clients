import { beforeEach, describe, expect, it, vi } from "vitest";
import { Starcite } from "../src/client";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "../src/errors";
import { MemoryStore } from "../src/session-store";

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

  it("restores persisted pending appends from the session store and auto-flushes them", async () => {
    const sessionToken = makeTailSessionToken("ses_persisted_outbox", "writer");
    const store = new MemoryStore();
    const starcite = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      store,
    });
    const session = await starcite.session({
      token: sessionToken,
      appendOptions: {
        autoFlush: false,
      },
    });

    const queuedAppend = session.append({ text: "persist me" });
    queuedAppend.catch(() => undefined);

    const storedBeforeRestore = store.load("ses_persisted_outbox");
    const persistedProducerId = storedBeforeRestore?.append?.producerId;
    expect(storedBeforeRestore?.append?.pending).toHaveLength(1);
    expect(storedBeforeRestore?.append?.pending[0]?.request.producer_seq).toBe(
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
      store,
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
      return store.load("ses_persisted_outbox")?.append?.pending.length === 0;
    }, "persisted append queue to flush");
    expect(store.load("ses_persisted_outbox")?.append?.pending).toHaveLength(0);
    expect(restoredSession.appendState()).toEqual(
      expect.objectContaining({
        status: "idle",
        lastAcknowledgedProducerSeq: 1,
        pending: [],
      })
    );
  });

  it("restores a terminally paused outbox without auto-flushing it again", async () => {
    const sessionToken = makeTailSessionToken("ses_persisted_pause", "writer");
    const store = new MemoryStore();

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
      store,
    });
    const session = await starcite.session({ token: sessionToken });
    const firstAppendResult = session
      .append({ text: "bad payload" })
      .catch((error) => error);

    const firstError = await firstAppendResult;
    expect(firstError).toBeInstanceOf(StarciteApiError);
    expect(session.appendState().status).toBe("paused");
    expect(store.load("ses_persisted_pause")?.append?.status).toBe("paused");

    fetchMock.mockClear();

    const restoredClient = new Starcite({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      store,
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
