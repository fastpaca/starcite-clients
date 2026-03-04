import type {
  AppendResult,
  SessionAppendInput,
  SessionEvent,
  SessionEventListener,
  SessionOnEventOptions,
} from "@starcite/sdk";
import type { ChatStatus, UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  appendUserMessageEvent,
  chatAssistantChunkEventType,
  isChatEventType,
  toUIMessagesFromEvents,
} from "./chat-protocol";

export interface StarciteChatSession {
  readonly id: string;
  append(input: SessionAppendInput): Promise<AppendResult>;
  events(): readonly SessionEvent[];
  on(
    eventName: "event",
    listener: SessionEventListener,
    options?: SessionOnEventOptions<SessionEvent>
  ): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
}

export type SendMessageInput<TMessage extends UIMessage = UIMessage> =
  | {
      text: string;
    }
  | (Omit<TMessage, "id"> & { id?: string });

export interface UseStarciteChatOptions {
  session: StarciteChatSession;
  id?: string;
  userMessageSource?: string;
  onError?: (error: Error) => void;
}

export interface UseStarciteChatResult<TMessage extends UIMessage = UIMessage> {
  messages: TMessage[];
  sendMessage: (message: SendMessageInput<TMessage>) => Promise<void>;
  status: ChatStatus;
}

interface ChatStateSnapshot<TMessage extends UIMessage = UIMessage> {
  messages: TMessage[];
  assistantOpen: boolean;
}

function createMessageId(): string {
  return crypto.randomUUID();
}

function isTerminalAssistantChunkType(type: string): boolean {
  return type === "finish" || type === "abort";
}

const assistantChunkPayloadSchema = z.object({
  kind: z.literal(chatAssistantChunkEventType),
  chunk: z.object({ type: z.string() }),
});

function readAssistantChunkType(payload: unknown): string | undefined {
  const result = assistantChunkPayloadSchema.safeParse(payload);
  return result.success ? result.data.chunk.type : undefined;
}

function hasTextInput<TMessage extends UIMessage>(
  message: SendMessageInput<TMessage>
): message is { text: string } {
  return "text" in message && !("parts" in message);
}

function normalizeOutgoingMessage<TMessage extends UIMessage = UIMessage>(
  input: SendMessageInput<TMessage>
): TMessage {
  if (hasTextInput(input)) {
    return {
      id: createMessageId(),
      role: "user",
      parts: [{ type: "text", text: input.text }],
    } as TMessage;
  }

  return {
    ...input,
    id: input.id ?? createMessageId(),
  } as TMessage;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

async function readChatState<TMessage extends UIMessage = UIMessage>(
  events: readonly SessionEvent[]
): Promise<ChatStateSnapshot<TMessage>> {
  const messages = await toUIMessagesFromEvents<TMessage>(events);
  let assistantOpen = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== chatAssistantChunkEventType) {
      continue;
    }

    const chunkType = readAssistantChunkType(event.payload);
    if (!chunkType) {
      break;
    }

    assistantOpen = !isTerminalAssistantChunkType(chunkType);
    break;
  }

  return {
    messages,
    assistantOpen,
  };
}

export function useStarciteChat<TMessage extends UIMessage = UIMessage>(
  options: UseStarciteChatOptions
): UseStarciteChatResult<TMessage> {
  const { session, id, userMessageSource = "use-chat", onError } = options;

  const sessionResetKey = id ?? session.id;

  const [messages, setMessages] = useState<TMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");

  const refreshVersionRef = useRef(0);
  const sessionKeyRef = useRef(sessionResetKey);
  const onErrorRef = useRef(onError);
  const liveRefreshScheduledRef = useRef(false);
  const replayRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const reportError = useCallback((error: unknown): Error => {
    const normalized = normalizeError(error);
    setStatus("error");
    onErrorRef.current?.(normalized);
    return normalized;
  }, []);

  const refreshFromSession = useCallback(() => {
    const version = refreshVersionRef.current + 1;
    refreshVersionRef.current = version;

    const snapshot = [...session.events()];

    readChatState<TMessage>(snapshot)
      .then((chatState) => {
        if (refreshVersionRef.current !== version) {
          return;
        }

        setMessages(chatState.messages);
        setStatus((current) => {
          if (chatState.assistantOpen) {
            return "streaming";
          }

          return current === "submitted" ? "submitted" : "ready";
        });
      })
      .catch((error) => {
        reportError(error);
      });
  }, [reportError, session]);

  const scheduleLiveRefreshFromSession = useCallback(() => {
    if (liveRefreshScheduledRef.current) {
      return;
    }

    liveRefreshScheduledRef.current = true;
    setTimeout(() => {
      liveRefreshScheduledRef.current = false;
      refreshFromSession();
    }, 16);
  }, [refreshFromSession]);

  const scheduleReplayRefreshFromSession = useCallback(() => {
    if (replayRefreshTimeoutRef.current !== null) {
      clearTimeout(replayRefreshTimeoutRef.current);
    }

    replayRefreshTimeoutRef.current = setTimeout(() => {
      replayRefreshTimeoutRef.current = null;
      refreshFromSession();
    }, 120);
  }, [refreshFromSession]);

  const sendMessage = useCallback(
    async (message: SendMessageInput<TMessage>): Promise<void> => {
      const requestSessionKey = sessionKeyRef.current;
      const outgoingMessage = normalizeOutgoingMessage<TMessage>(message);

      setStatus("submitted");

      try {
        await appendUserMessageEvent(
          session,
          outgoingMessage as Record<string, unknown>,
          {
            source: userMessageSource,
          }
        );

        if (sessionKeyRef.current !== requestSessionKey) {
          return;
        }

        refreshFromSession();
      } catch (error) {
        refreshVersionRef.current += 1;
        throw reportError(error);
      }
    },
    [refreshFromSession, reportError, session, userMessageSource]
  );

  const onSessionEvent = useCallback(
    (event: SessionEvent, context?: { replayed: boolean }): void => {
      if (!isChatEventType(event.type)) {
        return;
      }

      if (!context?.replayed && event.type === chatAssistantChunkEventType) {
        const chunkType = readAssistantChunkType(event.payload);
        if (chunkType && isTerminalAssistantChunkType(chunkType)) {
          setStatus("ready");
        } else {
          setStatus("streaming");
        }
      }

      if (context?.replayed) {
        scheduleReplayRefreshFromSession();
      } else {
        scheduleLiveRefreshFromSession();
      }
    },
    [scheduleLiveRefreshFromSession, scheduleReplayRefreshFromSession]
  );

  useEffect(() => {
    sessionKeyRef.current = sessionResetKey;
    refreshVersionRef.current += 1;
    setMessages([]);
    setStatus("ready");

    refreshFromSession();

    const offEvent = session.on("event", onSessionEvent, { replay: false });
    const offError = session.on("error", (error: Error) => {
      onErrorRef.current?.(normalizeError(error));
    });

    return () => {
      refreshVersionRef.current += 1;

      liveRefreshScheduledRef.current = false;
      if (replayRefreshTimeoutRef.current !== null) {
        clearTimeout(replayRefreshTimeoutRef.current);
        replayRefreshTimeoutRef.current = null;
      }

      offEvent();
      offError();
    };
  }, [onSessionEvent, refreshFromSession, session, sessionResetKey]);

  return useMemo(
    () => ({
      messages,
      sendMessage,
      status,
    }),
    [messages, sendMessage, status]
  );
}
