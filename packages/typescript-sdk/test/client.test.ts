import { beforeEach, describe, expect, it, vi } from "vitest";
import { StarciteClient } from "../src/client";
import { StarciteConnectionError } from "../src/errors";
import type { StarciteWebSocket } from "../src/types";

class FakeWebSocket implements StarciteWebSocket {
  readonly url: string;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(listener);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }

    handlers.delete(listener);
    if (handlers.size === 0) {
      this.listeners.delete(type);
    }
  }

  close(): void {
    return;
  }

  emit(type: string, event: unknown): void {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(event);
    }
  }
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
        actor: "agent:researcher",
        producer_id: "producer:researcher",
        producer_seq: 1,
        source: "agent",
      })
    );
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
    sockets[0]?.emit("close", {});

    await expect(donePromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(sockets[0]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_tail/tail?cursor=0"
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
});
