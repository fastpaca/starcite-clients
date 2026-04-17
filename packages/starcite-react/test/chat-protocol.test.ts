import { describe, expect, it, vi } from "vitest";
import {
  appendAssistantChunkEvent,
  appendAssistantTextMessage,
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

  it("appends a complete assistant text message as chunk events", async () => {
    const append = vi.fn().mockResolvedValue({ deduped: false, seq: 13 });

    await expect(
      appendAssistantTextMessage({ append }, "hello from the assistant", {
        messageId: "assistant_1",
        partId: "part_1",
        source: "agent",
      })
    ).resolves.toBeUndefined();

    expect(append.mock.calls).toEqual([
      [
        {
          type: chatAssistantChunkEventType,
          source: "agent",
          payload: {
            kind: chatAssistantChunkEventType,
            chunk: {
              type: "start",
              messageId: "assistant_1",
            },
          },
        },
      ],
      [
        {
          type: chatAssistantChunkEventType,
          source: "agent",
          payload: {
            kind: chatAssistantChunkEventType,
            chunk: {
              type: "text-start",
              id: "part_1",
            },
          },
        },
      ],
      [
        {
          type: chatAssistantChunkEventType,
          source: "agent",
          payload: {
            kind: chatAssistantChunkEventType,
            chunk: {
              type: "text-delta",
              id: "part_1",
              delta: "hello from the assistant",
            },
          },
        },
      ],
      [
        {
          type: chatAssistantChunkEventType,
          source: "agent",
          payload: {
            kind: chatAssistantChunkEventType,
            chunk: {
              type: "text-end",
              id: "part_1",
            },
          },
        },
      ],
      [
        {
          type: chatAssistantChunkEventType,
          source: "agent",
          payload: {
            kind: chatAssistantChunkEventType,
            chunk: {
              type: "finish",
              finishReason: "stop",
            },
          },
        },
      ],
    ]);
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
});
