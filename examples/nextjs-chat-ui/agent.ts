import { openai } from "@ai-sdk/openai";
import {
  appendAssistantChunkEvent,
  chatUserMessageEventType,
  toUIMessagesFromEvents,
} from "@starcite/react/chat-protocol";
import { convertToModelMessages, streamText } from "ai";
import { Starcite } from "@starcite/sdk";

const sessions = new Set<string>();

async function runSessionAgent(sessionId: string): Promise<void> {
  const apiKey = process.env.STARCITE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing STARCITE_API_KEY for nextjs-chat-ui agent");
  }

  const starcite = new Starcite({
    apiKey,
    baseUrl: process.env.STARCITE_BASE_URL || "https://api.starcite.io",
  });
  const identity = starcite.agent({
    id: process.env.STARCITE_AGENT_ID || "nextjs-demo-agent",
  });

  const session = await starcite.session({
    identity,
    id: sessionId,
    title: "Next.js demo chat",
  });

  session.on(
    "event",
    async (event, context) => {
      try {
        // On reattach/catch-up, session emits replayed historical events.
        // Only process new live user messages.
        if (context.replayed || event.type !== chatUserMessageEventType) {
          return;
        }

        const messages = await toUIMessagesFromEvents(session.events());
        if (messages.length === 0) {
          return;
        }

        const result = streamText({
          model: openai(process.env.OPENAI_MODEL || "gpt-4o-mini"),
          system: "You are a concise assistant in a Starcite demo chat.",
          messages: convertToModelMessages(messages),
        });

        for await (const chunk of result.toUIMessageStream()) {
          console.log(chunk);
          await appendAssistantChunkEvent(
            session,
            chunk as unknown as Record<string, unknown>,
            {
              source: "openai",
            }
          );
        }
      } catch (error) {
        console.error("nextjs-chat-ui agent event handler failed", error);
      }
    },
    { replay: false }
  );

  session.on("error", (error) => {
    console.warn("nextjs-chat-ui session stream warning", error.message);
  });
}

// kickstarts the agent loop in the background - bad in prod but good enough
// for an example. you should probably use a proper workflow manager to manage
// retries etc
export async function registerSession(sessionId: string): Promise<void> {
  if (sessions.has(sessionId)) {
    return;
  }

  sessions.add(sessionId);
  try {
    await runSessionAgent(sessionId);
  } catch (error) {
    sessions.delete(sessionId);
    console.error("nextjs-chat-ui failed to start session agent", error);
    throw error;
  }
}
