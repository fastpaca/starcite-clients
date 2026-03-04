import { describe, expect, it, vi } from "vitest";
import {
  appendAssistantChunkEvent,
  appendUserMessageEvent,
  chatAssistantChunkEventType,
  chatUserMessageEventType,
  createAssistantChunkEnvelope,
  createUserMessageEnvelope,
  parseChatPayloadEnvelope,
  toUIMessagesFromEvents,
} from "../src/chat-protocol";

describe("chat protocol", () => {
  it("wraps and parses user message envelopes", () => {
    const envelope = createUserMessageEnvelope({
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });

    expect(parseChatPayloadEnvelope(envelope)).toEqual(envelope);
  });

  it("wraps and parses assistant chunk envelopes", () => {
    const envelope = createAssistantChunkEnvelope({
      type: "start",
      messageId: "assistant_1",
    });

    expect(parseChatPayloadEnvelope(envelope)).toEqual(envelope);
  });

  it("throws for invalid envelope payloads", () => {
    expect(() =>
      parseChatPayloadEnvelope({ role: "user", parts: [{ type: "text" }] })
    ).toThrow("Invalid chat payload envelope");
  });

  it("appends wrapped user messages", async () => {
    const append = vi.fn().mockResolvedValue({ deduped: false, seq: 12 });

    await expect(
      appendUserMessageEvent(
        { append },
        {
          id: "msg_user",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
        {
          source: "ui",
        }
      )
    ).resolves.toEqual({ deduped: false, seq: 12 });

    expect(append).toHaveBeenCalledWith({
      type: chatUserMessageEventType,
      source: "ui",
      payload: {
        kind: chatUserMessageEventType,
        message: {
          id: "msg_user",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      },
    });
  });

  it("appends wrapped assistant chunks", async () => {
    const append = vi.fn().mockResolvedValue({ deduped: false, seq: 13 });

    await expect(
      appendAssistantChunkEvent(
        { append },
        {
          type: "finish",
          finishReason: "stop",
        },
        {
          source: "agent",
        }
      )
    ).resolves.toEqual({ deduped: false, seq: 13 });

    expect(append).toHaveBeenCalledWith({
      type: chatAssistantChunkEventType,
      source: "agent",
      payload: {
        kind: chatAssistantChunkEventType,
        chunk: {
          type: "finish",
          finishReason: "stop",
        },
      },
    });
  });

  it("projects best-effort messages when assistant chunks are malformed", async () => {
    const events = [
      {
        type: chatUserMessageEventType,
        payload: createUserMessageEnvelope({
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({ type: "start" }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_1",
          delta: "broken ordering",
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({ type: "finish" }),
      },
    ] as const;

    await expect(toUIMessagesFromEvents(events)).resolves.toEqual([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  it("deduplicates replayed chat messages by stable message id", async () => {
    const events = [
      {
        type: chatUserMessageEventType,
        payload: createUserMessageEnvelope({
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "start",
          messageId: "a1",
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "text-start",
          id: "part_1",
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_1",
          delta: "first",
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        }),
      },
      {
        type: chatUserMessageEventType,
        payload: createUserMessageEnvelope({
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "start",
          messageId: "a1",
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "text-start",
          id: "part_2",
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_2",
          delta: "second",
        }),
      },
      {
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        }),
      },
    ] as const;

    const messages = await toUIMessagesFromEvents(events);

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.id)).toEqual(["u1", "a1"]);

    const assistant = messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "second",
        }),
      ])
    );
  });
});
