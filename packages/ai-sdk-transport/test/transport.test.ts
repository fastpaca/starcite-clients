import {
  MemoryStore,
  StarciteIdentity,
  StarciteSession,
  type StarciteWebSocket,
} from "@starcite/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantChunkEnvelope,
  createUserMessageEnvelope,
  StarciteChatTransport,
} from "../src/transport";
import type { ChatChunk } from "../src/types";

const chatUserMessageEventType = "chat.user.message";
const chatAssistantChunkEventType = "chat.assistant.chunk";

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
  type: string,
  payload: unknown,
  actor = "agent:assistant"
): string {
  return JSON.stringify({
    seq,
    type,
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
      new Response(JSON.stringify({ seq, last_seq: seq, deduped: false }), {
        status: 201,
      })
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
      payload: {
        kind: "chat.user.message",
        message: {
          role: "user",
          parts: [{ type: "text", text: "Hello from UI" }],
        },
      },
      source: "use-chat",
    });

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("open", undefined);

    const chunksPromise = collectChunks(stream);

    // User's own event at seq=1 is skipped (seq <= cursor)
    sockets[0]?.emit("message", {
      data: tailEvent(
        1,
        chatUserMessageEventType,
        createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "Hello from UI" }],
        }),
        "agent:user"
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        2,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "start",
          messageId: "assistant_1",
        })
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        3,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        })
      ),
    });

    const chunks = await chunksPromise;
    expect(chunks).toEqual([
      { type: "start", messageId: "assistant_1" },
      { type: "finish", finishReason: "stop" },
    ]);

    transport.dispose();
    session.disconnect();
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
      data: tailEvent(
        1,
        chatUserMessageEventType,
        createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "Q" }],
        }),
        "agent:user"
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        2,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "start",
          messageId: "m_assistant",
        })
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        3,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "text-start",
          id: "p_assistant",
        })
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        4,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "text-delta",
          id: "p_assistant",
          delta: "schema native",
        })
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        5,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "text-end",
          id: "p_assistant",
        })
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        6,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        })
      ),
    });

    await expect(chunksPromise).resolves.toEqual([
      { type: "start", messageId: "m_assistant" },
      { type: "text-start", id: "p_assistant" },
      { type: "text-delta", id: "p_assistant", delta: "schema native" },
      { type: "text-end", id: "p_assistant" },
      { type: "finish", finishReason: "stop" },
    ]);

    transport.dispose();
    session.disconnect();
  });

  it("subscription survives finish — second sendMessages reuses connection", async () => {
    mockAppendResponse(1);
    mockAppendResponse(3);

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

    const stream1 = await transport.sendMessages({
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

    const firstChunksPromise = collectChunks(stream1);

    sockets[0]?.emit("message", {
      data: tailEvent(
        1,
        chatUserMessageEventType,
        createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "first" }],
        }),
        "agent:user"
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        2,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        })
      ),
    });

    await expect(firstChunksPromise).resolves.toEqual([
      { type: "finish", finishReason: "stop" },
    ]);

    // Second sendMessages should work — subscription stays alive after finish.
    const stream2 = await transport.sendMessages({
      chatId: "ses_ai",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        { id: "m2", role: "user", parts: [{ type: "text", text: "second" }] },
      ],
    });

    // No new websocket should have been opened.
    expect(sockets).toHaveLength(1);

    const secondChunksPromise = collectChunks(stream2);

    sockets[0]?.emit("message", {
      data: tailEvent(
        3,
        chatUserMessageEventType,
        createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "second" }],
        }),
        "agent:user"
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        4,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "start",
          messageId: "m_second",
        })
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        5,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        })
      ),
    });

    await expect(secondChunksPromise).resolves.toEqual([
      { type: "start", messageId: "m_second" },
      { type: "finish", finishReason: "stop" },
    ]);

    transport.dispose();
    session.disconnect();
  });

  it("returns null from reconnectToStream when session has no events", async () => {
    const session = createTestSession({
      id: "ses_empty",
      fetchFn: fetchMock,
      websocketFactory: (url: string) => new FakeWebSocket(url),
    });

    const transport = new StarciteChatTransport({ session });

    await expect(
      transport.reconnectToStream({ chatId: "ses_empty" })
    ).resolves.toBeNull();
  });

  it("returns null from reconnectToStream when last assistant chunk is finish", async () => {
    mockAppendResponse(1);

    const sockets: FakeWebSocket[] = [];
    const session = createTestSession({
      id: "ses_finished",
      fetchFn: fetchMock,
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const transport = new StarciteChatTransport({ session });

    const stream = await transport.sendMessages({
      chatId: "ses_finished",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
      ],
    });

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("open", undefined);

    const chunksPromise = collectChunks(stream);

    sockets[0]?.emit("message", {
      data: tailEvent(
        1,
        chatUserMessageEventType,
        createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "Hi" }],
        }),
        "agent:user"
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        2,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "start",
          messageId: "m_done",
        })
      ),
    });
    sockets[0]?.emit("message", {
      data: tailEvent(
        3,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        })
      ),
    });

    await chunksPromise;
    transport.dispose();
    session.disconnect();

    await expect(
      transport.reconnectToStream({ chatId: "ses_finished" })
    ).resolves.toBeNull();
  });

  it("reconnectToStream returns a stream for incomplete generation", async () => {
    mockAppendResponse(1);

    const sockets: FakeWebSocket[] = [];
    const session = createTestSession({
      id: "ses_partial",
      fetchFn: fetchMock,
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const transport = new StarciteChatTransport({ session });

    const stream = await transport.sendMessages({
      chatId: "ses_partial",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
      ],
    });

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("open", undefined);

    sockets[0]?.emit("message", {
      data: tailEvent(
        1,
        chatUserMessageEventType,
        createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "Hi" }],
        }),
        "agent:user"
      ),
    });
    // Emit a start chunk but no finish — generation is still in progress.
    sockets[0]?.emit("message", {
      data: tailEvent(
        2,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "start",
          messageId: "m_in_progress",
        })
      ),
    });

    // Wait for the start chunk to arrive at the transport's controller.
    // This ensures the session's async pipeline has propagated the event.
    const reader = stream.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.value).toMatchObject({ type: "start" });
    reader.releaseLock();

    // reconnectToStream sees the incomplete generation and returns a stream.
    // (This also closes the first stream via streamResponse.)
    const reconnectStream = await transport.reconnectToStream({
      chatId: "ses_partial",
    });
    expect(reconnectStream).not.toBeNull();

    if (reconnectStream === null) {
      throw new Error("Expected non-null reconnect stream");
    }
    const reconnectChunksPromise = collectChunks(reconnectStream);

    sockets[0]?.emit("message", {
      data: tailEvent(
        3,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        })
      ),
    });

    await expect(reconnectChunksPromise).resolves.toEqual([
      { type: "finish", finishReason: "stop" },
    ]);

    transport.dispose();
    session.disconnect();
  });

  it("closes the reconnect stream when sendMessages is called", async () => {
    mockAppendResponse(1);
    mockAppendResponse(3);

    const sockets: FakeWebSocket[] = [];
    const session = createTestSession({
      id: "ses_cancel",
      fetchFn: fetchMock,
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const transport = new StarciteChatTransport({ session });

    // First send a message and leave the generation incomplete.
    const stream = await transport.sendMessages({
      chatId: "ses_cancel",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
      ],
    });

    await waitForSocketCount(sockets, 1);
    sockets[0]?.emit("open", undefined);

    sockets[0]?.emit("message", {
      data: tailEvent(
        1,
        chatUserMessageEventType,
        createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "Hi" }],
        }),
        "agent:user"
      ),
    });
    // Emit start but no finish — incomplete generation.
    sockets[0]?.emit("message", {
      data: tailEvent(
        2,
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "start",
          messageId: "m_in_progress",
        })
      ),
    });

    // Wait for the start chunk to arrive at the transport's controller.
    const reader = stream.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.value).toMatchObject({ type: "start" });
    reader.releaseLock();

    // reconnectToStream returns a stream (incomplete generation).
    // This also closes the first stream internally.
    const reconnectStream = await transport.reconnectToStream({
      chatId: "ses_cancel",
    });
    expect(reconnectStream).not.toBeNull();

    if (reconnectStream === null) {
      throw new Error("Expected non-null reconnect stream");
    }
    const reconnectReader = reconnectStream.getReader();

    // Calling sendMessages should close the reconnect stream.
    await transport.sendMessages({
      chatId: "ses_cancel",
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        { id: "m2", role: "user", parts: [{ type: "text", text: "Bye" }] },
      ],
    });

    const reconnectResult = await reconnectReader.read();
    expect(reconnectResult.done).toBe(true);

    transport.dispose();
    session.disconnect();
  });
});
