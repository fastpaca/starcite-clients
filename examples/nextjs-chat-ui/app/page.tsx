"use client";

import { useChat } from "@ai-sdk/react";
import {
  createStarciteChatTransport,
  toUIMessagesFromEvents,
} from "@starcite/ai-sdk-transport";
import { Starcite, type StarciteSession } from "@starcite/sdk";
import {
  isReasoningUIPart,
  isTextUIPart,
  isToolOrDynamicToolUIPart,
  type ChatTransport,
  type UIMessage,
} from "ai";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const defaultBaseUrl = "https://anor-ai.starcite.io";
const defaultSessionId = "nextjs-demo-session";
const sessionIdCacheKey = "starcite:nextjs-chat-ui:session-id";

interface ChatBootstrap {
  transport: ChatTransport<UIMessage>;
  initialMessages: UIMessage[];
}

async function fetchSessionToken(
  sessionId: string
): Promise<{ token: string; sessionId: string }> {
  const response = await fetch("/api/starcite/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });

  return (await response.json()) as { token: string; sessionId: string };
}

async function hydrateHistoryMessages(
  session: StarciteSession
): Promise<UIMessage[]> {
  const events: Array<{ payload: unknown }> = [];
  for await (const item of session.tail({
    cursor: 0,
    catchUpIdleMs: 10_000,
    follow: false,
    replay: true,
  })) {
    events.push(item.event);
  }

  const messages = await toUIMessagesFromEvents(events);
  return messages.map((message, index) => ({
    id: `history_${index + 1}`,
    ...message,
  }));
}

export default function Page() {
  const [sessionId, setSessionId] = useState(defaultSessionId);
  const [sessionIdInput, setSessionIdInput] = useState(defaultSessionId);
  const [token, setToken] = useState<string>();
  const [chatBootstrap, setChatBootstrap] = useState<ChatBootstrap>();
  const tokenRequestCounter = useRef(0);

  useEffect(() => {
    const cached = localStorage.getItem(sessionIdCacheKey);
    if (cached) {
      setSessionId(cached);
      setSessionIdInput(cached);
    }
  }, []);

  useEffect(() => {
    const requestCounter = tokenRequestCounter.current + 1;
    tokenRequestCounter.current = requestCounter;
    let active = true;

    localStorage.setItem(sessionIdCacheKey, sessionId);
    setToken(undefined);

    fetchSessionToken(sessionId).then((nextSession) => {
      if (!active || tokenRequestCounter.current !== requestCounter) {
        return;
      }

      setToken(nextSession.token);
      if (nextSession.sessionId !== sessionId) {
        setSessionId(nextSession.sessionId);
        setSessionIdInput(nextSession.sessionId);
      }
    });

    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!token) {
      setChatBootstrap(undefined);
      return;
    }

    let active = true;
    const baseUrl = process.env.NEXT_PUBLIC_STARCITE_BASE_URL || defaultBaseUrl;
    const session = new Starcite({ baseUrl }).session({ token });

    const transport = createStarciteChatTransport({ session });
    (async () => {
      try {
        const initialMessages = await hydrateHistoryMessages(session);
        if (!active) {
          return;
        }
        setChatBootstrap({ transport, initialMessages });
      } catch (error) {
        console.error("nextjs-chat-ui hydration failed", error);
        if (!active) {
          return;
        }
        setChatBootstrap({ transport, initialMessages: [] });
      }
    })();

    return () => {
      active = false;
      session.disconnect();
    };
  }, [token]);

  function onSessionSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setSessionId(sessionIdInput);
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-4xl flex-col gap-4 p-4">
      <header className="rounded-xl border bg-card p-3">
        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Starcite x AI SDK x AI Elements
        </p>
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={onSessionSubmit}>
          <Input
            onChange={(event) => setSessionIdInput(event.target.value)}
            placeholder="Session ID"
            value={sessionIdInput}
          />
          <Button type="submit" variant="secondary">
            Use Session
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">Active: {sessionId}</p>
      </header>

      {chatBootstrap && token ? (
        <ChatThread
          initialMessages={chatBootstrap.initialMessages}
          sessionId={sessionId}
          transport={chatBootstrap.transport}
        />
      ) : (
        <>
          <section className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
            <Conversation className="h-full">
              <ConversationContent>
                <ConversationEmptyState
                  description="Initializing session..."
                  title="No messages yet"
                />
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>
          </section>

          <PromptInput className="rounded-xl border bg-card p-2" onSubmit={() => undefined}>
            <PromptInputTextarea disabled placeholder="Initializing session..." />
            <PromptInputFooter>
              <PromptInputTools>
                <span className="text-xs text-muted-foreground">
                  Powered by useChat + createStarciteChatTransport
                </span>
              </PromptInputTools>
              <PromptInputSubmit disabled />
            </PromptInputFooter>
          </PromptInput>
        </>
      )}
    </main>
  );
}

function ChatThread({
  initialMessages,
  sessionId,
  transport,
}: {
  initialMessages: UIMessage[];
  sessionId: string;
  transport: ChatTransport<UIMessage>;
}) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, stop } = useChat({
    id: sessionId,
    messages: initialMessages,
    transport,
  });
  const isBusy = status === "submitted" || status === "streaming";

  function onPromptSubmit(message: PromptInputMessage): void {
    const text = message.text.trim();
    if (!text) {
      return;
    }
    setInput("");
    void sendMessage({ text });
  }

  return (
    <>
      <section className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
        <Conversation className="h-full">
          <ConversationContent>
            {messages.length === 0 ? (
              <ConversationEmptyState
                description="Ask a question to start streaming."
                title="No messages yet"
              />
            ) : (
              messages.map((message) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    {message.parts.map((part, index) => {
                      const key = `${message.id}-${index}`;

                      if (isTextUIPart(part)) {
                        return <MessageResponse key={key}>{part.text}</MessageResponse>;
                      }

                      if (isReasoningUIPart(part)) {
                        return (
                          <MessageResponse key={key}>{part.text}</MessageResponse>
                        );
                      }

                      if (isToolOrDynamicToolUIPart(part)) {
                        return (
                          <MessageResponse key={key}>
                            {part.errorText
                              ? part.errorText
                              : part.output
                                ? JSON.stringify(part.output, null, 2)
                                : JSON.stringify(part.input, null, 2)}
                          </MessageResponse>
                        );
                      }

                      return null;
                    })}
                  </MessageContent>
                </Message>
              ))
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      </section>

      <PromptInput className="rounded-xl border bg-card p-2" onSubmit={onPromptSubmit}>
        <PromptInputTextarea
          disabled={isBusy}
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder="Ask something..."
          value={input}
        />
        <PromptInputFooter>
          <PromptInputTools>
            <span className="text-xs text-muted-foreground">
              Powered by useChat + createStarciteChatTransport
            </span>
          </PromptInputTools>
          <PromptInputSubmit
            disabled={status === "ready" && input.trim().length === 0}
            onStop={stop}
            status={status}
          />
        </PromptInputFooter>
      </PromptInput>
    </>
  );
}
