import type { StarciteWebSocket } from "@starcite/sdk";
import { StarciteClient } from "@starcite/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StarciteChatTransport } from "../src/transport";
import type { ChatChunk } from "../src/types";

const PRODUCER_ID_PREFIX_REGEX = /^producer:use-chat:/;

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

function mockCreateSessionAndAppend(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  sessionId: string,
  appendSeq: number
): void {
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: sessionId,
          title: null,
          metadata: {},
          last_seq: 0,
          created_at: "2026-02-18T00:00:00Z",
          updated_at: "2026-02-18T00:00:00Z",
        }),
        { status: 201 }
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq: appendSeq, last_seq: appendSeq, deduped: false }),
        { status: 201 }
      )
    );
}

describe("StarciteChatTransport", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("appends user input and maps first assistant content event", async () => {
    mockCreateSessionAndAppend(fetchMock, "ses_ai", 1);

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

    const transport = new StarciteChatTransport({
      client,
      producerId: "producer:test-tab",
    });

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

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/v1/sessions",
      expect.objectContaining({ method: "POST" })
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:4000/v1/sessions/ses_ai/append",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          type: "chat.user.message",
          payload: { text: "Hello from UI" },
          actor: "agent:user",
          producer_id: "producer:test-tab",
          producer_seq: 1,
          source: "use-chat",
          metadata: {
            messageId: "msg_user",
            trigger: "submit-message",
          },
        }),
      })
    );

    expect(sockets[0]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_ai/tail?cursor=1"
    );

    const chunksPromise = collectChunks(stream);

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 2,
        type: "content",
        payload: {
          text: "Hi there!",
          messageId: "assistant_1",
          textPartId: "part_1",
        },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 1,
      }),
    });

    const chunks = await chunksPromise;
    expect(chunks).toEqual([
      { type: "start", messageId: "assistant_1" },
      { type: "text-start", id: "part_1" },
      { type: "text-delta", id: "part_1", delta: "Hi there!" },
      { type: "text-end", id: "part_1" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("forwards AI SDK chunks from tail payload when payload already matches schema", async () => {
    mockCreateSessionAndAppend(fetchMock, "ses_chunks", 1);

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

    const transport = new StarciteChatTransport({
      client,
      producerId: "producer:test-tab",
    });
    const stream = await transport.sendMessages({
      chatId: "ses_chunks",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Q" }] },
      ],
    });

    const chunksPromise = collectChunks(stream);

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 2,
        type: "content",
        payload: { type: "start", messageId: "m_assistant" },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 1,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 3,
        type: "content",
        payload: { type: "text-start", id: "p_assistant" },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 2,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 4,
        type: "content",
        payload: {
          type: "text-delta",
          id: "p_assistant",
          delta: "schema native",
        },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 3,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 5,
        type: "content",
        payload: { type: "text-end", id: "p_assistant" },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 4,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 6,
        type: "content",
        payload: { type: "finish", finishReason: "stop" },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 5,
      }),
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
    mockCreateSessionAndAppend(fetchMock, "ses_ai", 5);

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

    const transport = new StarciteChatTransport({
      client,
      producerId: "producer:test-tab",
    });

    const stream = await transport.sendMessages({
      chatId: "ses_ai",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "first" }] },
      ],
    });

    const firstChunksPromise = collectChunks(stream);

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 6,
        type: "content",
        payload: { text: "first answer" },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 1,
      }),
    });

    await firstChunksPromise;

    const reconnectStream = await transport.reconnectToStream({
      chatId: "ses_ai",
    });

    expect(reconnectStream).not.toBeNull();
    expect(sockets[1]?.url).toBe(
      "ws://localhost:4000/v1/sessions/ses_ai/tail?cursor=6"
    );

    const reconnectReadPromise = reconnectStream?.getReader().read();
    sockets[1]?.emit("close", { code: 1000, reason: "finished" });

    await expect(reconnectReadPromise).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("returns null on reconnect when no cursor is known", async () => {
    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: () => new FakeWebSocket("ws://localhost"),
    });

    const transport = new StarciteChatTransport({ client });

    await expect(
      transport.reconnectToStream({
        chatId: "ses_unknown",
      })
    ).resolves.toBeNull();
  });

  it("uses a unique producer id by default for each transport instance", async () => {
    mockCreateSessionAndAppend(fetchMock, "ses_one", 1);
    mockCreateSessionAndAppend(fetchMock, "ses_two", 1);

    const client = new StarciteClient({
      baseUrl: "http://localhost:4000",
      fetch: fetchMock,
      websocketFactory: (url) => new FakeWebSocket(url),
    });

    const transportA = new StarciteChatTransport({ client });
    const transportB = new StarciteChatTransport({ client });

    await transportA.sendMessages({
      chatId: "ses_one",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "first tab" }],
        },
      ],
    });
    await transportB.sendMessages({
      chatId: "ses_two",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "second tab" }],
        },
      ],
    });

    const appendOne = JSON.parse(
      ((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body ??
        "{}") as string
    ) as { producer_id?: string };
    const appendTwo = JSON.parse(
      ((fetchMock.mock.calls[3]?.[1] as RequestInit | undefined)?.body ??
        "{}") as string
    ) as { producer_id?: string };

    expect(appendOne.producer_id).toMatch(PRODUCER_ID_PREFIX_REGEX);
    expect(appendTwo.producer_id).toMatch(PRODUCER_ID_PREFIX_REGEX);
    expect(appendOne.producer_id).not.toBe(appendTwo.producer_id);
  });
});
