import { describe, expect, it } from "vitest";
import {
  createAssistantChunkEnvelope,
  createUserMessageEnvelope,
  toModelMessagesFromEvents,
  toUIMessagesFromEvents,
} from "../src/index";

function getTextPartText(
  payload: { parts: readonly { type: string }[] } | undefined
): string {
  if (!payload) {
    return "";
  }

  for (const part of payload.parts) {
    if (
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      return part.text;
    }
  }

  return "";
}

describe("public API", () => {
  it("exports intended runtime symbols from package root", async () => {
    const module = await import("../src/index");

    expect(Object.keys(module).sort()).toEqual([
      "chatAssistantChunkEnvelopeKind",
      "chatAssistantChunkEnvelopeSchema",
      "chatAssistantChunkEventType",
      "chatPayloadEnvelopeSchema",
      "chatUserMessageEnvelopeKind",
      "chatUserMessageEnvelopeSchema",
      "chatUserMessageEventType",
      "createAssistantChunkEnvelope",
      "createStarciteChatTransport",
      "createUserMessageEnvelope",
      "toModelMessagesFromEvents",
      "toUIMessagesFromEvents",
    ]);
  });

  it("projects strict envelope payloads into native UI messages", async () => {
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
      {
        payload: createAssistantChunkEnvelope({
          type: "start",
          messageId: "assistant_2",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "text-start",
          id: "part_2",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_2",
          delta: "second reply",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "text-end",
          id: "part_2",
        }),
      },
      {
        payload: createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        }),
      },
    ];

    const uiMessages = await toUIMessagesFromEvents(events);

    expect(uiMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    const assistantMessages = uiMessages.filter(
      (message) => message.role === "assistant"
    );
    expect(assistantMessages).toHaveLength(2);
    expect(getTextPartText(assistantMessages.at(0))).toBe("hi there");
    expect(getTextPartText(assistantMessages.at(1))).toBe("second reply");
  });

  it("projects strict envelope payloads into model messages", async () => {
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
});
