import type { SessionHandle, TailEvent } from "@starcite/sdk";
import type { ChatStatus, UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import {
  chatAssistantChunkEventType,
  chatUserMessageEventType,
  createUserMessageEnvelope,
  isChatEventType,
  toUIMessagesFromEvents,
} from "./chat-protocol";
import { useStarciteSession } from "./use-starcite-session";

export type { SessionHandle as StarciteChatSession } from "@starcite/sdk";

type SendUserMessageInput<TMessage extends UIMessage = UIMessage> = Omit<
  TMessage,
  "id" | "role"
> & {
  id?: string;
  role?: "user";
};

export type SendMessageInput<TMessage extends UIMessage = UIMessage> =
  | {
      text: string;
    }
  | SendUserMessageInput<TMessage>;

export interface UseStarciteChatOptions {
  session: SessionHandle | null | undefined;
  id?: string;
  userMessageSource?: string;
  onError?: (error: Error) => void;
}

export interface UseStarciteChatResult<TMessage extends UIMessage = UIMessage> {
  messages: TMessage[];
  sendMessage: (message: SendMessageInput<TMessage>) => Promise<void>;
  status: ChatStatus;
}

// --- Internals ---

function isTerminalChunkType(type: string): boolean {
  return type === "finish" || type === "abort";
}

const chunkPayloadSchema = z.object({
  kind: z.literal(chatAssistantChunkEventType),
  chunk: z.object({ type: z.string() }),
});

function readChunkType(payload: unknown): string | undefined {
  const result = chunkPayloadSchema.safeParse(payload);
  return result.success ? result.data.chunk.type : undefined;
}

function isAssistantOpen(events: readonly TailEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || event.type !== chatAssistantChunkEventType) {
      continue;
    }
    const chunkType = readChunkType(event.payload);
    return chunkType ? !isTerminalChunkType(chunkType) : false;
  }
  return false;
}

function normalizeOutgoing<TMessage extends UIMessage>(
  input: SendMessageInput<TMessage>
): TMessage {
  if ("text" in input && !("parts" in input)) {
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: input.text }],
    } as TMessage;
  }

  if ("role" in input && input.role && input.role !== "user") {
    throw new Error(
      `sendMessage() only accepts user messages; received role '${input.role}'`
    );
  }

  return {
    ...input,
    role: "user",
    id: (input as { id?: string }).id ?? crypto.randomUUID(),
  } as TMessage;
}

// --- Hook ---

export function useStarciteChat<TMessage extends UIMessage = UIMessage>(
  options: UseStarciteChatOptions
): UseStarciteChatResult<TMessage> {
  const { session, id, userMessageSource = "use-chat", onError } = options;
  const sessionKey = id ?? session?.id ?? "__none__";

  const { events, append } = useStarciteSession({
    session,
    id,
    onError,
  });

  const [messages, setMessages] = useState<TMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");

  useEffect(() => {
    setMessages([]);
    setStatus("ready");

    if (sessionKey === "__none__") {
      return;
    }
  }, [sessionKey]);

  // Project events → UIMessage[] (async because of readUIMessageStream)
  useEffect(() => {
    let cancelled = false;

    if (sessionKey === "__none__") {
      return () => {
        cancelled = true;
      };
    }

    // Eagerly set streaming status from latest chunk
    const open = isAssistantOpen(events);
    setStatus((cur) => {
      if (open) {
        return "streaming";
      }
      if (cur === "submitted") {
        return "submitted";
      }
      return "ready";
    });

    // Async projection
    const chatEvents = events.filter((e) => isChatEventType(e.type));
    toUIMessagesFromEvents<TMessage>(chatEvents)
      .then((msgs) => {
        if (!cancelled) {
          setMessages(msgs);
        }
      })
      .catch(() => {
        /* intentionally swallowed */
      });

    return () => {
      cancelled = true;
    };
  }, [events, sessionKey]);

  const sendMessage = useCallback(
    async (message: SendMessageInput<TMessage>): Promise<void> => {
      try {
        const outgoing = normalizeOutgoing<TMessage>(message);
        setStatus("submitted");
        const envelope = createUserMessageEnvelope(
          outgoing as Record<string, unknown>
        );
        await append({
          type: chatUserMessageEventType,
          source: userMessageSource,
          payload: envelope,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        setStatus("error");
        onError?.(err);
        throw err;
      }
    },
    [append, onError, userMessageSource]
  );

  return useMemo(
    () => ({ messages, sendMessage, status }),
    [messages, sendMessage, status]
  );
}
