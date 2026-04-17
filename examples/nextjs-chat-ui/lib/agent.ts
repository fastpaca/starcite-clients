import { openai } from "@ai-sdk/openai";
import {
  appendAssistantChunkEvent,
  chatUserMessageEventType,
  toUIMessagesFromEvents,
} from "@starcite/react/chat-protocol";
import {
  SessionAgent,
  SessionAgentSupervisor,
} from "@starcite/session-supervisor";
import type { StarciteSession, TailEvent } from "@starcite/sdk";
import { convertToModelMessages, streamText } from "ai";
import { starcite } from "./starcite";

const agentIdentity = starcite.agent({
  id: process.env.STARCITE_AGENT_ID || "nextjs-demo-agent",
});

class NextjsDemoAgent extends SessionAgent<StarciteSession> {
  async receive(event: TailEvent): Promise<void> {
    if (event.type !== chatUserMessageEventType) {
      return;
    }

    const messages = await toUIMessagesFromEvents(this.session.events());
    if (messages.length === 0) {
      return;
    }

    const result = streamText({
      model: openai(process.env.OPENAI_MODEL || "gpt-4o-mini"),
      system: "You are a concise assistant in a Starcite demo chat.",
      messages: convertToModelMessages(messages),
    });

    for await (const chunk of result.toUIMessageStream()) {
      await appendAssistantChunkEvent(this.session, chunk, {
        source: "openai",
      });
    }
  }
}

const supervisor = new SessionAgentSupervisor({
  Agent: NextjsDemoAgent,
  agent: agentIdentity,
  starcite,
});

void supervisor.start().catch((error: unknown) => {
  console.error("[nextjs-chat-ui] failed to start session supervisor", error);
});
