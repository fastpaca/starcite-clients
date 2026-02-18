import type { StarciteWebSocket } from "@starcite/sdk";
import { StarciteClient } from "@starcite/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StarciteChatTransport } from "../src/transport";
import type { UIMessageChunkLike } from "../src/types";

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
  stream: ReadableStream<UIMessageChunkLike>
): Promise<UIMessageChunkLike[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunkLike[] = [];

  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }

    chunks.push(next.value);
  }

  return chunks;
}

describe("StarciteChatTransport", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("appends user input and streams custom chat.response.* protocol", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ seq: 1, last_seq: 1, deduped: false }), {
        status: 201,
      })
    );

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
      autoCreateSession: false,
      closeOnFirstAssistantMessage: false,
    });

    const stream = await transport.sendMessages({
      chatId: "ses_ai",
      trigger: "submit-message",
      messages: [{ id: "msg_user", role: "user", text: "Hello from UI" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
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
        type: "chat.response.start",
        payload: { messageId: "assistant_1", textPartId: "part_1" },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 1,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 3,
        type: "chat.response.delta",
        payload: { delta: "Hi there!" },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 2,
      }),
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 4,
        type: "chat.response.end",
        payload: { finishReason: "stop" },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 3,
      }),
    });

    const chunks = await chunksPromise;
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(chunks[0]).toMatchObject({
      type: "start",
      messageId: "assistant_1",
    });
    expect(chunks[1]).toMatchObject({
      type: "text-start",
      id: "part_1",
    });
    expect(chunks[2]).toMatchObject({
      type: "text-delta",
      id: "part_1",
      delta: "Hi there!",
    });
  });

  it("supports one-shot content events and auto-finishes after the first assistant message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ seq: 10, last_seq: 10, deduped: false }), {
        status: 201,
      })
    );

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
      autoCreateSession: false,
    });

    const stream = await transport.sendMessages({
      chatId: "ses_ai",
      trigger: "submit-message",
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Q" }] },
      ],
    });

    const chunksPromise = collectChunks(stream);

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        seq: 11,
        type: "content",
        payload: { text: "Single response event" },
        actor: "agent:assistant",
        producer_id: "producer:assistant",
        producer_seq: 1,
      }),
    });

    const chunks = await chunksPromise;
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(chunks[2]).toMatchObject({
      type: "text-delta",
      delta: "Single response event",
    });
  });

  it("reconnects using the last tracked cursor", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ seq: 5, last_seq: 5, deduped: false }), {
        status: 201,
      })
    );

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
      autoCreateSession: false,
    });

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
    sockets[1]?.emit("close", {});

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

    const transport = new StarciteChatTransport({
      client,
      autoCreateSession: false,
    });

    await expect(
      transport.reconnectToStream({
        chatId: "ses_unknown",
      })
    ).resolves.toBeNull();
  });
});
