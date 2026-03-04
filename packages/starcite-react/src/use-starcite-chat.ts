import type {
  AppendResult,
  SessionAppendInput,
  SessionEvent,
  SessionEventListener,
  SessionOnEventOptions,
} from "@starcite/sdk";
import type { ChatStatus, UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendUserMessageEvent,
  chatAssistantChunkEventType,
  chatUserMessageEventType,
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

export type SendMessageInput =
  | {
      text: string;
    }
  | (Omit<UIMessage, "id"> & { id?: string });

export interface UseStarciteChatOptions {
  session: StarciteChatSession;
  id?: string;
  userMessageSource?: string;
  onError?: (error: Error) => void;
}

export interface UseStarciteChatResult {
  messages: UIMessage[];
  sendMessage: (message: SendMessageInput) => Promise<void>;
  status: ChatStatus;
}

interface ChatStateSnapshot {
  messages: UIMessage[];
  assistantOpen: boolean;
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isChatEventType(type: string): boolean {
  return (
    type === chatUserMessageEventType || type === chatAssistantChunkEventType
  );
}

function isTerminalAssistantChunkType(type: string): boolean {
  return type === "finish" || type === "abort";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readAssistantChunkType(payload: unknown): string | undefined {
  if (!isRecord(payload) || payload.kind !== chatAssistantChunkEventType) {
    return undefined;
  }

  const chunk = payload.chunk;
  if (!isRecord(chunk)) {
    return undefined;
  }

  return typeof chunk.type === "string" ? chunk.type : undefined;
}

function hasTextInput(message: SendMessageInput): message is { text: string } {
  return "text" in message && !("parts" in message);
}

function normalizeOutgoingMessage(input: SendMessageInput): UIMessage {
  if (hasTextInput(input)) {
    return {
      id: createMessageId(),
      role: "user",
      parts: [{ type: "text", text: input.text }],
    };
  }

  return {
    ...input,
    id: input.id ?? createMessageId(),
  };
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

async function readChatState(
  events: readonly SessionEvent[]
): Promise<ChatStateSnapshot> {
  const messages = await toUIMessagesFromEvents(events);
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

export function useStarciteChat(
  options: UseStarciteChatOptions
): UseStarciteChatResult {
  const { session, id, userMessageSource = "use-chat", onError } = options;

  const sessionResetKey = id ?? session.id;

  const [messages, setMessages] = useState<UIMessage[]>([]);
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

    readChatState(snapshot)
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
    async (message: SendMessageInput): Promise<void> => {
      const requestSessionKey = sessionKeyRef.current;
      const outgoingMessage = normalizeOutgoingMessage(message);

      setStatus("submitted");

      try {
        await appendUserMessageEvent(
          session,
          outgoingMessage as unknown as Record<string, unknown>,
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
    const offError = session.on("error", (error) => {
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
