import { describe, expect, it } from "vitest";
import {
  toModelMessagesFromPayloads,
  toUIMessagesFromPayloads,
} from "../src/history";

describe("history projection", () => {
  it("projects mixed UIMessage and UIMessageChunk payloads into UI messages", async () => {
    const payloads: unknown[] = [
      {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      { type: "start", messageId: "assistant_1" },
      { type: "text-start", id: "part_1" },
      { type: "text-delta", id: "part_1", delta: "hi there" },
      { type: "text-end", id: "part_1" },
      { type: "finish", finishReason: "stop" },
      {
        role: "user",
        parts: [{ type: "text", text: "second turn" }],
      },
    ];

    const uiMessages = await toUIMessagesFromPayloads(payloads);
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

  it("projects payloads into model messages", async () => {
    const payloads: unknown[] = [
      {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      { type: "start", messageId: "assistant_1" },
      { type: "text-start", id: "part_1" },
      { type: "text-delta", id: "part_1", delta: "hi there" },
      { type: "text-end", id: "part_1" },
      { type: "finish", finishReason: "stop" },
    ];

    const modelMessages = await toModelMessagesFromPayloads(payloads);
    expect(modelMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("ignores non-native payloads", async () => {
    const payloads: unknown[] = [
      {
        parts: [{ type: "text", text: "legacy payload without role" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "native payload" }],
      },
    ];

    const uiMessages = await toUIMessagesFromPayloads(payloads);
    expect(uiMessages).toHaveLength(1);
    expect(uiMessages[0]?.role).toBe("user");
  });
});
