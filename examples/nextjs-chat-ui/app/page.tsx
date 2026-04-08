"use client";

import { useStarciteChat } from "@starcite/react";
import {
  LocalStorageSessionCache,
  Starcite,
  type StarciteSession,
} from "@starcite/sdk";
import { useEffect, useState } from "react";
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
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";

async function fetchToken(sessionId?: string) {
  const response = await fetch("/api/starcite/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });

  if (!response.ok) {
    throw new Error(`Session token request failed (${response.status}).`);
  }

  return (await response.json()) as { token: string; sessionId: string };
}

export default function Page() {
  const [starcite] = useState(
    () =>
      new Starcite({
        baseUrl:
          process.env.NEXT_PUBLIC_STARCITE_BASE_URL ||
          "https://api.starcite.io",
        cache:
          typeof window === "undefined"
            ? undefined
            : new LocalStorageSessionCache({
                keyPrefix: "starcite:nextjs-chat-ui",
              }),
      })
  );
  const [session, setSession] = useState<StarciteSession>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const fromQuery = new URLSearchParams(window.location.search).get(
        "sessionId"
      );
      const next = await fetchToken(fromQuery ?? undefined);
      if (cancelled) {
        return;
      }

      setError(undefined);
      setSession(
        starcite.session({
          token: next.token,
          refreshToken: async ({ sessionId }) => {
            return (await fetchToken(sessionId)).token;
          },
        })
      );

      const url = new URL(window.location.href);
      url.searchParams.set("sessionId", next.sessionId);
      window.history.replaceState({}, "", url);
    })().catch((connectError: unknown) => {
      if (cancelled) {
        return;
      }

      setError(
        connectError instanceof Error
          ? connectError.message
          : "Session connection failed."
      );
    });

    return () => {
      cancelled = true;
    };
  }, [starcite]);

  return (
    <main className="mx-auto flex h-dvh w-full max-w-4xl flex-col gap-3 p-4">
      <section className="rounded-lg border bg-card px-4 py-3">
        <h1 className="font-semibold text-lg">
          sessionId: {session?.id ?? "creating..."}
        </h1>
        {error ? (
          <p className="mt-2 text-destructive text-sm">{error}</p>
        ) : null}
      </section>

      {session ? (
        <ChatPane session={session} />
      ) : (
        <section className="flex min-h-0 flex-1 items-center justify-center rounded-lg border bg-card text-muted-foreground text-sm">
          Connecting session...
        </section>
      )}
    </main>
  );
}

function ChatPane({ session }: { session: StarciteSession }) {
  const [chatError, setChatError] = useState<string>();
  const { messages, sendMessage, status } = useStarciteChat({
    id: session.id,
    onError: (error) => {
      setChatError(error.message);
    },
    session,
  });
  const busy = status === "submitted" || status === "streaming";

  return (
    <>
      <section className="rounded-lg border bg-card px-4 py-2 text-muted-foreground text-xs uppercase tracking-wide">
        <p>
          status: {status} | streaming right now:{" "}
          {status === "streaming" ? "yes" : "no"}
        </p>
        {chatError ? (
          <p className="mt-1 text-destructive normal-case tracking-normal">
            last error: {chatError}
          </p>
        ) : null}
      </section>

      <Conversation className="min-h-0 flex-1 rounded-lg border bg-card">
        <ConversationContent className="gap-5 p-4">
          {messages.length === 0 ? (
            <ConversationEmptyState
              description="Reconnect with the same ?sessionId=... to verify durable history."
              title="No messages yet"
            />
          ) : (
            messages.map((message, index) => (
              <Message from={message.role} key={`${message.id}-${index}`}>
                <MessageContent>
                  <MessageResponse className="[&_pre]:max-h-80 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/30 [&_pre]:p-3 [&_pre_code]:text-xs">
                    {message.parts
                      .flatMap((part) => {
                        const text = (part as { text?: unknown }).text;
                        return typeof text === "string" ? [text] : [];
                      })
                      .join("\n\n") || "[non-text message]"}
                  </MessageResponse>
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptInput
        className="rounded-lg border bg-card p-2"
        onSubmit={async ({ text }) => {
          const next = text.trim();
          if (next.length === 0 || busy) {
            return;
          }

          setChatError(undefined);
          try {
            await sendMessage({ text: next });
          } catch (error) {
            const err =
              error instanceof Error ? error : new Error("Chat append failed.");
            setChatError(err.message);
          }
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            className="min-h-20"
            disabled={busy}
            placeholder="Ask something..."
          />
        </PromptInputBody>
        <PromptInputFooter>
          <span className="px-1 text-muted-foreground text-xs">
            {busy ? "Streaming..." : "Ready"}
          </span>
          <PromptInputSubmit disabled={busy} status={status} />
        </PromptInputFooter>
      </PromptInput>
    </>
  );
}
