import type { StarciteWebSocket } from "@starcite/sdk";
import { StarciteClient } from "@starcite/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StarciteChatTransport } from "../src/transport";
import type { UIMessageChunk } from "../src/types";

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
  stream: ReadableStream<UIMessageChunk>
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];

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

    const transport = new StarciteChatTransport({ client });

    const stream = await transport.sendMessages({
      chatId: "ses_ai",
      trigger: "submit-message",
      messages: [{ id: "msg_user", role: "user", text: "Hello from UI" }],
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
          producer_id: "producer:use-chat",
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

    const transport = new StarciteChatTransport({ client });

    const stream = await transport.sendMessages({
      chatId: "ses_ai",
      trigger: "submit-message",
      messages: [{ id: "m1", role: "user", text: "first" }],
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
});
