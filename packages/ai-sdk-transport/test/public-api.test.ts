import { describe, expect, it } from "vitest";
import type { ChatHistoryPayload } from "../src/index";
import {
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
  it("exports only intended runtime symbols from package root", async () => {
    const module = await import("../src/index");

    expect(Object.keys(module).sort()).toEqual([
      "createStarciteChatTransport",
      "toModelMessagesFromEvents",
      "toUIMessagesFromEvents",
    ]);
  });

  it("projects event payloads into native UI messages while ignoring non-chat payloads", async () => {
    const events: Array<{ payload: ChatHistoryPayload | { foo: string } }> = [
      {
        payload: {
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      { payload: { foo: "ignore-me" } },
      { payload: { type: "start", messageId: "assistant_1" } },
      { payload: { type: "text-start", id: "part_1" } },
      { payload: { type: "text-delta", id: "part_1", delta: "hi there" } },
      { payload: { type: "text-end", id: "part_1" } },
      { payload: { type: "finish", finishReason: "stop" } },
      {
        payload: {
          role: "user",
          parts: [{ type: "text", text: "second turn" }],
        },
      },
      { payload: { type: "start", messageId: "assistant_2" } },
      { payload: { type: "text-start", id: "part_2" } },
      { payload: { type: "text-delta", id: "part_2", delta: "second reply" } },
      { payload: { type: "text-end", id: "part_2" } },
      { payload: { type: "finish", finishReason: "stop" } },
    ];

    const uiMessages = await toUIMessagesFromEvents(events, {
      unknownPayloadStrategy: "ignore",
    });

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

  it("projects event payloads into model messages", async () => {
    const events: Array<{ payload: ChatHistoryPayload }> = [
      {
        payload: {
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      { payload: { type: "start", messageId: "assistant_1" } },
      { payload: { type: "text-start", id: "part_1" } },
      { payload: { type: "text-delta", id: "part_1", delta: "hi there" } },
      { payload: { type: "text-end", id: "part_1" } },
      { payload: { type: "finish", finishReason: "stop" } },
    ];

    const modelMessages = await toModelMessagesFromEvents(events);
    expect(modelMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
