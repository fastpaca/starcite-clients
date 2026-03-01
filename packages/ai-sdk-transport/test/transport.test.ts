import {
  MemoryStore,
  StarciteIdentity,
  StarciteSession,
  type StarciteWebSocket,
} from "@starcite/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StarciteChatTransport } from "../src/transport";
import type { ChatChunk } from "../src/types";

class FakeWebSocket implements StarciteWebSocket {
  readonly url: string;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener<TType extends string>(
    type: TType,
    listener: (event: never) => void
  ): void {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(listener as (event: unknown) => void);
    this.listeners.set(type, handlers);
  }

  removeEventListener<TType extends string>(
    type: TType,
    listener: (event: never) => void
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

async function collectChunks(
  stream: ReadableStream<ChatChunk>
): Promise<ChatChunk[]> {
  const reader = stream.getReader();
  const chunks: ChatChunk[] = [];

  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }

    chunks.push(next.value);
  }

  return chunks;
}

async function waitForSocketCount(
  sockets: FakeWebSocket[],
  count: number
): Promise<void> {
  while (sockets.length < count) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function tailEvent(
  seq: number,
  payload: Record<string, unknown>,
  actor = "agent:assistant"
): string {
  return JSON.stringify({
    seq,
    type: "content",
    payload,
    actor,
    producer_id: `producer:${actor.split(":")[1]}`,
    producer_seq: seq,
  });
}

const testIdentity = new StarciteIdentity({
  tenantId: "test-tenant",
  id: "user:tester",
  type: "user",
});

function createTestSession(options: {
  id: string;
  fetchFn: typeof fetch;
  websocketFactory: (url: string) => FakeWebSocket;
}): StarciteSession {
  return new StarciteSession({
    id: options.id,
    token: "test-token",
    identity: testIdentity,
    store: new MemoryStore(),
    transport: {
      baseUrl: "http://localhost:4000/v1",
      websocketBaseUrl: "ws://localhost:4000/v1",
      authorization: "Bearer test-token",
      fetchFn: options.fetchFn,
      headers: new Headers(),
      websocketFactory: options.websocketFactory,
    },
  });
}

describe("StarciteChatTransport", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  function mockAppendResponse(seq: number): void {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq, last_seq: seq, deduped: false }),
        { status: 201 }
      )
    );
  }

  it("appends user input and forwards assistant chunk payloads", async () => {
    mockAppendResponse(1);

    const sockets: FakeWebSocket[] = [];
    const session = createTestSession({
      id: "ses_ai",
      fetchFn: fetchMock,
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const transport = new StarciteChatTransport({ session });

    const stream = await transport.sendMessages({
      chatId: "ses_ai",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        {
          id: "msg_user",
          role: "user",
          parts: [{ type: "text", text: "Hello from UI" }],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/v1/sessions/ses_ai/append",
      expect.objectContaining({ method: "POST" })
    );

    const appendBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string
    );
    expect(appendBody).toMatchObject({
      type: "chat.user.message",
      payload: { parts: [{ type: "text", text: "Hello from UI" }] },
      source: "use-chat",
    });

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("open", undefined);

    const chunksPromise = collectChunks(stream);

    // User's own event at seq=1 is skipped (seq <= cursor)
    sockets[0]?.emit("message", {
      data: tailEvent(1, { text: "Hello from UI" }, "agent:user"),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(2, { type: "start", messageId: "assistant_1" }),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(3, { type: "finish", finishReason: "stop" }),
    });

    const chunks = await chunksPromise;
    expect(chunks).toEqual([
      { type: "start", messageId: "assistant_1" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("forwards AI SDK chunks from tail payload when payload already matches schema", async () => {
    mockAppendResponse(1);

    const sockets: FakeWebSocket[] = [];
    const session = createTestSession({
      id: "ses_chunks",
      fetchFn: fetchMock,
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const transport = new StarciteChatTransport({ session });
    const stream = await transport.sendMessages({
      chatId: "ses_chunks",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Q" }] },
      ],
    });

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("open", undefined);

    const chunksPromise = collectChunks(stream);

    sockets[0]?.emit("message", {
      data: tailEvent(1, { text: "Q" }, "agent:user"),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(2, { type: "start", messageId: "m_assistant" }),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(3, { type: "text-start", id: "p_assistant" }),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(4, {
        type: "text-delta",
        id: "p_assistant",
        delta: "schema native",
      }),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(5, { type: "text-end", id: "p_assistant" }),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(6, { type: "finish", finishReason: "stop" }),
    });

    await expect(chunksPromise).resolves.toEqual([
      { type: "start", messageId: "m_assistant" },
      { type: "text-start", id: "p_assistant" },
      { type: "text-delta", id: "p_assistant", delta: "schema native" },
      { type: "text-end", id: "p_assistant" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("reconnects using the last tracked cursor", async () => {
    mockAppendResponse(1);

    const sockets: FakeWebSocket[] = [];
    const session = createTestSession({
      id: "ses_ai",
      fetchFn: fetchMock,
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const transport = new StarciteChatTransport({ session });

    const stream = await transport.sendMessages({
      chatId: "ses_ai",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "first" }] },
      ],
    });

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("open", undefined);

    const firstChunksPromise = collectChunks(stream);

    sockets[0]?.emit("message", {
      data: tailEvent(1, { text: "first" }, "agent:user"),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(2, { type: "finish", finishReason: "stop" }),
    });

    await expect(firstChunksPromise).resolves.toEqual([
      { type: "finish", finishReason: "stop" },
    ]);

    // Allow the session's live sync promise chain to fully settle
    // before reconnecting (liveSyncTask clears in .finally()).
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reconnectStream = await transport.reconnectToStream({
      chatId: "ses_ai",
    });

    expect(reconnectStream).not.toBeNull();

    await waitForSocketCount(sockets, 2);
    sockets[1]?.emit("open", undefined);
    expect(sockets[1]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_ai/tail?cursor=2&access_token=test-token"
    );

    const reconnectChunksPromise = collectChunks(reconnectStream!);

    sockets[1]?.emit("message", {
      data: tailEvent(3, { type: "start", messageId: "m_reconnect" }),
    });
    sockets[1]?.emit("message", {
      data: tailEvent(4, { type: "finish", finishReason: "stop" }),
    });

    await expect(reconnectChunksPromise).resolves.toEqual([
      { type: "start", messageId: "m_reconnect" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("returns null on reconnect when no messages have been sent", async () => {
    const session = createTestSession({
      id: "ses_unknown",
      fetchFn: fetchMock,
      websocketFactory: (url: string) => new FakeWebSocket(url),
    });

    const transport = new StarciteChatTransport({ session });

    await expect(
      transport.reconnectToStream({ chatId: "ses_unknown" })
    ).resolves.toBeNull();
  });
});
