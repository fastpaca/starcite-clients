import { openai } from "@ai-sdk/openai";
import {
  appendAssistantChunkEvent,
  chatUserMessageEventType,
  toUIMessagesFromEvents,
} from "@starcite/react/chat-protocol";
import { convertToModelMessages, streamText } from "ai";
import { starcite } from "./starcite";

const agentIdentity = starcite.agent({
  id: process.env.STARCITE_AGENT_ID || "nextjs-demo-agent",
});

starcite.on("session.created", (event) => {
  void (async () => {
    const session = await starcite.session({
      identity: agentIdentity,
      id: event.session_id,
      title: "Next.js demo chat",
    });

    session.on("event", async (sessionEvent) => {
      if (sessionEvent.type !== chatUserMessageEventType) {
        return;
      }

      const events = await session.range(1, sessionEvent.seq);
      const messages = await toUIMessagesFromEvents(events);
      if (messages.length === 0) {
        return;
      }

      const result = streamText({
        model: openai(process.env.OPENAI_MODEL || "gpt-4o-mini"),
        system: "You are a concise assistant in a Starcite demo chat.",
        messages: convertToModelMessages(messages),
      });

      for await (const chunk of result.toUIMessageStream()) {
        await appendAssistantChunkEvent(session, chunk, {
          source: "openai",
        });
      }
    });
  })();
});
