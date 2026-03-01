import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { decodeJwt } from "jose";
import { Starcite, StarciteIdentity } from "@starcite/sdk";

const defaultBaseUrl = "https://anor-ai.starcite.io";
const defaultModel = "gpt-4o-mini";
const userEventType = "chat.user.message";

interface AgentClaims {
  tenant_id?: string;
}

function getApiKey(): string {
  return process.env.STARCITE_API_KEY ?? process.env.STARCITE_API_TOKEN ?? "";
}

const apiKey = getApiKey();
const claims = decodeJwt(apiKey) as AgentClaims;
const starcite = new Starcite({
  apiKey,
  baseUrl: process.env.STARCITE_BASE_URL || defaultBaseUrl,
});
const identity = new StarciteIdentity({
  tenantId: claims.tenant_id!,
  id: process.env.STARCITE_AGENT_ID || "nextjs-demo-agent",
  type: "agent",
});

const sessions = new Set<string>();

async function runSessionAgent(sessionId: string): Promise<void> {
  try {
    const session = await starcite.session({
      identity,
      id: sessionId,
      title: "Next.js demo chat",
    });

    session.on("event", async (event) => {
      try {
        if (event.type !== userEventType) {
          return;
        }

        const parts = event.payload.parts;
        if (!Array.isArray(parts)) {
          return;
        }

        const messages = convertToModelMessages([
          {
            role: "user",
            parts: parts as UIMessage["parts"],
          },
        ]);

        const result = streamText({
          model: openai(process.env.OPENAI_MODEL || defaultModel),
          system: "You are a concise assistant in a Starcite demo chat.",
          messages,
        });

        for await (const chunk of result.toUIMessageStream()) {
          await session.append({
            source: "openai",
            payload: chunk,
          });
        }
      } catch (error) {
        console.error("nextjs-chat-ui agent event handler failed", error);
      }
    });
    session.on("error", (error) => {
      console.error("nextjs-chat-ui session stream failed", error);
      sessions.delete(sessionId);
      session.disconnect();
    });
  } catch (error) {
    console.error("nextjs-chat-ui failed to start session agent", error);
    sessions.delete(sessionId);
  }
}

export function registerSession(sessionId: string): void {
  if (sessions.has(sessionId)) {
    return;
  }

  sessions.add(sessionId);
  // Start the agent until it's done
  void runSessionAgent(sessionId);
}
