import { bench, describe } from "vitest";
import {
  chatAssistantChunkEventType,
  chatUserMessageEventType,
  createAssistantChunkEnvelope,
  createUserMessageEnvelope,
  toUIMessagesFromEvents,
} from "../src/chat-protocol";

interface ChatEvent {
  type: string;
  payload: unknown;
}

function makeConversationEvents(turns: number): ChatEvent[] {
  const events: ChatEvent[] = [];

  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({
      type: chatUserMessageEventType,
      payload: createUserMessageEnvelope({
        id: `u_${turn}`,
        role: "user",
        parts: [{ type: "text", text: `question ${turn}` }],
      }),
    });

    events.push({
      type: chatAssistantChunkEventType,
      payload: createAssistantChunkEnvelope({
        type: "start",
        messageId: `a_${turn}`,
      }),
    });
    events.push({
      type: chatAssistantChunkEventType,
      payload: createAssistantChunkEnvelope({
        type: "text-start",
        id: `part_${turn}`,
      }),
    });
    events.push({
      type: chatAssistantChunkEventType,
      payload: createAssistantChunkEnvelope({
        type: "text-delta",
        id: `part_${turn}`,
        delta: `answer ${turn}`,
      }),
    });
    events.push({
      type: chatAssistantChunkEventType,
      payload: createAssistantChunkEnvelope({
        type: "finish",
        finishReason: "stop",
      }),
    });
  }

  return events;
}

const baselineEvents = makeConversationEvents(50);
const replayDuplicateEvents = [...baselineEvents, ...baselineEvents];

describe("Chat projection overhead", () => {
  bench("project 50-turn conversation to UI messages", async () => {
    await toUIMessagesFromEvents(baselineEvents);
  });

  bench(
    "project 50-turn conversation with full replay duplicates",
    async () => {
      await toUIMessagesFromEvents(replayDuplicateEvents);
    }
  );
});
