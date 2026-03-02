import { openai } from "@ai-sdk/openai";
import {
  convertToModelMessages,
  readUIMessageStream,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { decodeJwt } from "jose";
import { Starcite, StarciteIdentity, type TailEvent } from "@starcite/sdk";

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

type HistoryMessage = Omit<UIMessage, "id">;

interface HistoryMessageEntry {
  seq: number;
  message: HistoryMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toHistoryUserMessage(event: TailEvent): HistoryMessageEntry | undefined {
  if (event.type !== userEventType) {
    return undefined;
  }

  if (!isRecord(event.payload)) {
    return undefined;
  }

  const parts = event.payload.parts;
  if (!Array.isArray(parts)) {
    return undefined;
  }

  return {
    seq: event.seq,
    message: {
      role: "user",
      parts: parts as UIMessage["parts"],
    },
  };
}

function toAssistantChunk(payload: unknown): UIMessageChunk | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  if (typeof payload.type !== "string") {
    return undefined;
  }

  return payload as UIMessageChunk;
}

function createChunkStream(
  chunks: readonly UIMessageChunk[]
): ReadableStream<UIMessageChunk> {
  let index = 0;
  return new ReadableStream<UIMessageChunk>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }

      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

async function buildConversationHistory(
  events: readonly TailEvent[]
): Promise<HistoryMessage[]> {
  const historyEntries: HistoryMessageEntry[] = [];
  const assistantChunks: UIMessageChunk[] = [];
  const assistantMessageStartSeq = new Map<string, number>();

  for (const event of events) {
    const userMessage = toHistoryUserMessage(event);
    if (userMessage) {
      historyEntries.push(userMessage);
      continue;
    }

    const assistantChunk = toAssistantChunk(event.payload);
    if (!assistantChunk) {
      continue;
    }

    assistantChunks.push(assistantChunk);

    if (
      assistantChunk.type === "start" &&
      typeof assistantChunk.messageId === "string" &&
      !assistantMessageStartSeq.has(assistantChunk.messageId)
    ) {
      assistantMessageStartSeq.set(assistantChunk.messageId, event.seq);
    }
  }

  if (assistantChunks.length > 0) {
    const assistantMessagesById = new Map<string, HistoryMessage>();
    for await (const message of readUIMessageStream({
      stream: createChunkStream(assistantChunks),
      terminateOnError: false,
    })) {
      if (message.role !== "assistant") {
        continue;
      }

      assistantMessagesById.set(message.id, {
        role: "assistant",
        parts: message.parts,
        metadata: message.metadata,
      });
    }

    for (const [messageId, message] of assistantMessagesById) {
      historyEntries.push({
        seq: assistantMessageStartSeq.get(messageId) ?? Number.MAX_SAFE_INTEGER,
        message,
      });
    }
  }

  historyEntries.sort((left, right) => left.seq - right.seq);
  return historyEntries.map((entry) => entry.message);
}

async function runSessionAgent(sessionId: string): Promise<void> {
  try {
    const session = await starcite.session({
      identity,
      id: sessionId,
      title: "Next.js demo chat",
    });

    session.on("event", async (event, context) => {
      try {
        if (context.replayed) {
          return;
        }

        if (event.type !== userEventType) {
          return;
        }

        const history = await buildConversationHistory(session.getSnapshot().events);
        if (history.length === 0) {
          return;
        }

        const messages = convertToModelMessages(history);

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
