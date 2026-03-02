import { describe, expect, it } from "vitest";
import {
  toModelMessagesFromEvents,
  toUIMessagesFromEvents,
} from "../src/index";
import {
  createAssistantChunkEnvelope,
  createUserMessageEnvelope,
} from "../src/transport";

describe("history projection", () => {
  it("preserves extended message payload fields", async () => {
    const events: Array<{ payload: unknown }> = [
      {
        payload: createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          metadata: { test: true },
          customField: { tenant: "acme" },
        }),
      },
    ];

    const uiMessages = await toUIMessagesFromEvents(events);
    const firstMessage = uiMessages[0] as Record<string, unknown> | undefined;
    expect(firstMessage?.customField).toEqual({ tenant: "acme" });
    expect(firstMessage?.metadata).toEqual({ test: true });
  });

  it("projects mixed envelopes into UI messages", async () => {
    const events: Array<{ payload: unknown }> = [
      {
        payload: createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "start",
          messageId: "assistant_1",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "text-start",
          id: "part_1",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_1",
          delta: "hi there",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "text-end",
          id: "part_1",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        }),
      },
      {
        payload: createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "second turn" }],
        }),
      },
    ];

    const uiMessages = await toUIMessagesFromEvents(events);
    expect(uiMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    const assistantMessage = uiMessages[1];
    const assistantText = assistantMessage?.parts.find(
      (part) => part.type === "text"
    );
    expect(assistantText && "text" in assistantText && assistantText.text).toBe(
      "hi there"
    );
  });

  it("projects envelopes into model messages", async () => {
    const events: Array<{ payload: unknown }> = [
      {
        payload: createUserMessageEnvelope({
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "start",
          messageId: "assistant_1",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "text-start",
          id: "part_1",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_1",
          delta: "hi there",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "text-end",
          id: "part_1",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        }),
      },
    ];

    const modelMessages = await toModelMessagesFromEvents(events);
    expect(modelMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("throws on invalid envelope payloads", async () => {
    const events: Array<{ payload: unknown }> = [
      {
        payload: {
          role: "user",
          parts: [{ type: "text", text: "missing kind wrapper" }],
        },
      },
    ];

    await expect(toUIMessagesFromEvents(events)).rejects.toThrow(
      "Invalid chat payload envelope"
    );
  });
});
