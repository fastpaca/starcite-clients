import { openai } from "@ai-sdk/openai";
import {
  appendAssistantChunkEvent,
  appendAssistantTextMessage,
  chatUserMessageEventType,
  toUIMessagesFromEvents,
} from "@starcite/react/chat-protocol";
import { streamText, convertToModelMessages } from "ai";
import type { StarciteSession, TailEvent } from "@starcite/sdk";
import { starcite } from "./starcite";

type AgentBootstrapState = typeof globalThis & {
  __starciteNextjsChatUiAgentStarted?: boolean;
};

const agentIdentity = starcite.agent({
  id: process.env.STARCITE_AGENT_ID ?? "nextjs-demo-agent",
});
const bootstrapState = globalThis as AgentBootstrapState;

if (!bootstrapState.__starciteNextjsChatUiAgentStarted) {
  bootstrapState.__starciteNextjsChatUiAgentStarted = true;

  starcite.on("session.created", (event) => {
    void attachChatResponder(event.session_id);
  });
}

async function attachChatResponder(sessionId: string): Promise<void> {
  const session = await starcite.session({
    identity: agentIdentity,
    id: sessionId,
    title: "Next.js demo chat",
  });

  session.on("event", (event) => {
    void respondToUserMessage(session, event);
  });
}

async function respondToUserMessage(
  session: StarciteSession,
  event: TailEvent
): Promise<void> {
  if (event.type !== chatUserMessageEventType) {
    return;
  }

  try {
    const events = await session.range(1, event.seq);
    const messages = await toUIMessagesFromEvents(events);
    if (messages.length === 0) {
      return;
    }

    const result = streamText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: "You are a concise assistant in a Starcite demo chat.",
      messages: convertToModelMessages(messages),
    });

    for await (const chunk of result.toUIMessageStream()) {
      await appendAssistantChunkEvent(session, chunk, {
        source: "openai",
      });
    }
  } catch (error) {
    await appendAssistantTextMessage(
      session,
      `Demo agent failed: ${errorMessage(error)}`,
      {
        source: "openai",
      }
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
