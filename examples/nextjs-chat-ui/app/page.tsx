"use client";

import { useChat } from "@ai-sdk/react";
import {
  createStarciteChatTransport,
  toUIMessagesFromEvents,
} from "@starcite/ai-sdk-transport";
import { LocalStorageSessionStore, Starcite } from "@starcite/sdk";
import {
  isTextUIPart,
  isToolOrDynamicToolUIPart,
  type ChatTransport,
  type UIMessage,
} from "ai";
import { type FormEvent, useEffect, useMemo, useState } from "react";
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
import { defaultBaseUrl } from "@/lib/starcite-server";

const defaultSessionId = "nextjs-demo-session";

async function fetchSessionToken(
  sessionId: string
): Promise<{ token: string; sessionId: string }> {
  const response = await fetch("/api/starcite/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });

  if (!response.ok) {
    throw new Error(`Session token request failed (${response.status}).`);
  }

  return (await response.json()) as { token: string; sessionId: string };
}

export default function Page() {
  const [sessionId, setSessionId] = useState(defaultSessionId);
  const [token, setToken] = useState<string>();
  const [sessionError, setSessionError] = useState<string>();
  const [isConnecting, setIsConnecting] = useState(false);

  const [initialMessages, setInitialMessages] = useState<UIMessage[]>();

  const chat = useMemo(() => {
    if (!token) {
      return undefined;
    }

    const baseUrl = process.env.NEXT_PUBLIC_STARCITE_BASE_URL || defaultBaseUrl;
    const store = new LocalStorageSessionStore({
      keyPrefix: "starcite:nextjs-chat-ui",
    });
    const session = new Starcite({ baseUrl, store }).session({ token });

    return {
      session,
      transport: createStarciteChatTransport({ session }),
    };
  }, [token]);

  useEffect(() => {
    if (!chat) {
      setInitialMessages(undefined);
      return () => {};
    }

    let cancelled = false;
    const events = chat.session.state().events;

    void toUIMessagesFromEvents(events).then((msgs) => {
      if (cancelled) return;
      setInitialMessages(msgs);
    });

    return () => {
      cancelled = true;
      chat.session.disconnect();
    };
  }, [chat]);

  async function connectToSession(id: string): Promise<void> {
    const normalizedId = id.trim();
    if (normalizedId.length === 0) {
      return;
    }

    setIsConnecting(true);
    setSessionError(undefined);
    setToken(undefined);

    try {
      const next = await fetchSessionToken(normalizedId);
      setToken(next.token);
      setSessionId(next.sessionId);
    } catch (error) {
      setSessionError(
        error instanceof Error ? error.message : "Session initialization failed."
      );
    } finally {
      setIsConnecting(false);
    }
  }

  useEffect(() => {
    void connectToSession(defaultSessionId);
  }, []);

  function onSessionSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void connectToSession(sessionId);
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-4xl flex-col gap-4 p-4">
      <header className="rounded-xl border bg-card p-3">
        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Starcite x AI SDK x AI Elements
        </p>
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={onSessionSubmit}>
          <Input
            onChange={(event) => setSessionId(event.target.value)}
            placeholder="Session ID"
            value={sessionId}
          />
          <Button type="submit" variant="secondary">
            Use Session
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">Active: {sessionId}</p>
      </header>

      {chat && initialMessages ? (
        <ChatThread
          initialMessages={initialMessages}
          sessionId={sessionId}
          transport={chat.transport}
        />
      ) : (
        <DisconnectedState
          description={sessionError ?? (isConnecting ? "Connecting..." : "Enter a session ID.")}
        />
      )}
    </main>
  );
}

function DisconnectedState({ description }: { description: string }) {
  return (
    <>
      <section className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
        <Conversation className="h-full">
          <ConversationContent>
            <ConversationEmptyState description={description} title="No messages yet" />
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      </section>

      <PromptInput className="rounded-xl border bg-card p-2" onSubmit={() => undefined}>
        <PromptInputTextarea disabled placeholder="Waiting for session..." />
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
    resume: true,
    transport,
  });

  function onPromptSubmit(message: PromptInputMessage): void {
    const text = message.text.trim();
    if (text.length === 0) {
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
              messages.map((message, messageIndex) => (
                <Message from={message.role} key={`${message.id}-${messageIndex}`}>
                  <MessageContent>
                    {message.parts.map((part, index) => {
                      const key = `${message.id}-${messageIndex}-${index}`;

                      if (isTextUIPart(part) || ("text" in part && part.type === "reasoning")) {
                        return (
                          <MessageResponse key={key}>
                            {(part as { text: string }).text}
                          </MessageResponse>
                        );
                      }

                      if (isToolOrDynamicToolUIPart(part)) {
                        return (
                          <MessageResponse key={key}>
                            {part.errorText ??
                              JSON.stringify(part.output ?? part.input ?? {}, null, 2)}
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
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask a question..."
          value={input}
        />
        <PromptInputFooter>
          <PromptInputTools>
            <span className="text-xs text-muted-foreground">
              Powered by useChat + createStarciteChatTransport
            </span>
          </PromptInputTools>
          <PromptInputSubmit onStop={stop} status={status} />
        </PromptInputFooter>
      </PromptInput>
    </>
  );
}
