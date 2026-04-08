"use client";

import { useStarciteSession } from "@starcite/react";
import {
  createStarcite,
  LocalStorageSessionStore,
  type StarciteSession,
  type TailEvent,
} from "@starcite/sdk";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  StickToBottom,
  useStickToBottomContext,
} from "use-stick-to-bottom";
import { cn } from "@/lib/utils";

type AgentColor = { bg: string; text: string; accent: string };
type FeedEntry = { agent: string; name: string; text: string; seq: number };
type FeedPresentation = {
  committed: FeedEntry[];
  pending: FeedEntry[];
  agents: Map<string, AgentColor>;
};

const COORDINATOR_COLOR: AgentColor = {
  bg: "bg-amber-50",
  text: "text-amber-700",
  accent: "border-amber-200",
};

const WORKER_COLORS: AgentColor[] = [
  { bg: "bg-blue-50", text: "text-blue-700", accent: "border-blue-200" },
  {
    bg: "bg-violet-50",
    text: "text-violet-700",
    accent: "border-violet-200",
  },
  {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    accent: "border-emerald-200",
  },
  { bg: "bg-rose-50", text: "text-rose-700", accent: "border-rose-200" },
  { bg: "bg-cyan-50", text: "text-cyan-700", accent: "border-cyan-200" },
];

async function fetchToken(sessionId?: string) {
  const response = await fetch("/api/starcite/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });

  if (!response.ok) {
    throw new Error(`Session token request failed (${response.status}).`);
  }

  return (await response.json()) as { sessionId: string; token: string };
}
export default function Page() {
  const { sessionId, session, error, retry, setError } = useViewerSession();
  const { events, append } = useStarciteSession({
    session,
    onError: (nextError) => setError(nextError.message),
  });

  const sendMessage = useCallback(
    (text: string) =>
      append({
        text,
        type: "message.user",
        source: "user",
      }),
    [append]
  );

  const { committed, pending, agents } = derivePresentation(events);

  if (!sessionId) {
    return (
      <div className="flex h-dvh items-center justify-center">
        {error ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <button
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              onClick={retry}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Creating session...</p>
        )}
      </div>
    );
  }

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr_auto] overflow-hidden">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className="text-sm font-semibold">Research Swarm</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {sessionId.slice(0, 20)}...
        </span>
      </header>

      <Feed agents={agents} committed={committed} pending={pending} />

      {pending.length > 0 ? (
        <StatusBar count={pending.length} />
      ) : (
        <InputBar onSend={sendMessage} />
      )}
    </div>
  );
}

function useViewerSession() {
  const [starcite] = useState(createBrowserClient);
  const [sessionId, setSessionId] = useState<string>();
  const [session, setSession] = useState<StarciteSession>();
  const [error, setError] = useState<string>();
  const bootedRef = useRef(false);

  const connect = useCallback(
    async (existingId?: string) => {
      try {
        setError(undefined);
        const { sessionId: nextSessionId, token } = await fetchToken(
          existingId
        );

        setSessionId(nextSessionId);
        setSession(
          starcite.session({
            token,
            refreshToken: async ({ sessionId }) => {
              return (await fetchToken(sessionId)).token;
            },
          })
        );

        const url = new URL(window.location.href);
        url.searchParams.set("sessionId", nextSessionId);
        window.history.replaceState({}, "", url);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed");
      }
    },
    [starcite]
  );

  useEffect(() => {
    if (bootedRef.current) {
      return;
    }

    bootedRef.current = true;
    void connect(currentSessionIdFromUrl());
  }, [connect]);

  const retry = useCallback(() => {
    bootedRef.current = false;
    void connect(currentSessionIdFromUrl());
  }, [connect]);

  return { error, retry, session, sessionId, setError };
}

function createBrowserClient() {
  return createStarcite({
    store:
      typeof window === "undefined"
        ? undefined
        : new LocalStorageSessionStore({
            keyPrefix: "starcite:multi-agent-viewer",
          }),
  });
}

function currentSessionIdFromUrl(): string | undefined {
  return new URLSearchParams(window.location.search).get("sessionId")?.trim();
}

function Feed({
  committed,
  pending,
  agents,
}: {
  committed: FeedEntry[];
  pending: FeedEntry[];
  agents: Map<string, AgentColor>;
}) {
  if (committed.length === 0 && pending.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Ask a question and watch the research swarm investigate it from multiple
        angles.
      </div>
    );
  }

  return (
    <StickToBottom className="flex-1 overflow-y-hidden" resize="smooth" role="log">
      <StickToBottom.Content className="mx-auto max-w-3xl space-y-3 p-4">
        {committed.map((entry) => renderEntry(entry, false, agents))}
        {pending.map((entry) => renderEntry(entry, true, agents))}
      </StickToBottom.Content>
      <ScrollToBottom />
    </StickToBottom>
  );
}

function renderEntry(
  entry: FeedEntry,
  streaming: boolean,
  agents: Map<string, AgentColor>
) {
  const color = agents.get(entry.agent);

  if (entry.agent === "user" || entry.agent === "coordinator") {
    return (
      <FullCard
        color={color}
        entry={entry}
        key={`${streaming ? "s" : "c"}-${entry.agent}-${entry.seq}`}
        streaming={streaming}
      />
    );
  }

  return (
    <WorkerCard
      color={color ?? WORKER_COLORS[0]!}
      entry={entry}
      key={`${streaming ? "s" : "c"}-${entry.agent}-${entry.seq}`}
      streaming={streaming}
    />
  );
}

function ScrollToBottom() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) {
    return null;
  }

  return (
    <button
      className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted"
      onClick={() => scrollToBottom()}
      type="button"
    >
      Scroll to bottom
    </button>
  );
}

const FullCard = memo(function FullCard({
  entry,
  color,
  streaming,
}: {
  entry: FeedEntry;
  color?: AgentColor;
  streaming?: boolean;
}) {
  const isUser = entry.agent === "user";

  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3",
        isUser ? "border-border bg-muted/30" : "border-transparent"
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <Avatar color={color} name={entry.name} />
        <span className={cn("text-xs font-semibold", color?.text ?? "text-gray-600")}>
          {isUser ? "You" : entry.name}
        </span>
        {streaming ? <Spinner className={color?.text} /> : null}
      </div>
      <Markdown text={entry.text} />
    </div>
  );
});

const WorkerCard = memo(function WorkerCard({
  entry,
  color,
  streaming,
}: {
  entry: FeedEntry;
  color: AgentColor;
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border",
        streaming ? color.accent : "border-border"
      )}
    >
      <button
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-muted/40"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <Avatar color={color} name={entry.name} />
        <span className={cn("truncate text-xs font-semibold", color.text)}>
          {entry.name}
        </span>
        {streaming ? (
          <Spinner className={color.text} />
        ) : (
          <span className="text-xs text-emerald-500">Done</span>
        )}
        <span
          className={cn(
            "ml-auto text-xs text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )}
        >
          &#x25BC;
        </span>
      </button>
      {expanded || streaming ? (
        <div className={cn("px-4", expanded ? "pb-4" : "pb-2")}>
          {expanded ? (
            <Markdown small text={entry.text} />
          ) : (
            <StreamingTail text={entry.text} />
          )}
        </div>
      ) : null}
    </div>
  );
});

function StreamingTail({ text }: { text: string }) {
  return (
    <div className="relative overflow-hidden" style={{ maxHeight: 80 }}>
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-white to-transparent dark:from-gray-950"
      />
      <div className="flex flex-col-reverse" style={{ maxHeight: 80 }}>
        <Markdown small text={text} />
      </div>
    </div>
  );
}

const Markdown = memo(function Markdown({
  text,
  small,
}: {
  text: string;
  small?: boolean;
}) {
  return (
    <Streamdown
      className={cn(
        "prose prose-sm prose-neutral max-w-none text-foreground/90 dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        small && "text-[13px] leading-relaxed"
      )}
    >
      {text}
    </Streamdown>
  );
});

function Avatar({ name, color }: { name: string; color?: AgentColor }) {
  return (
    <div
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
        color ? [color.bg, color.text] : "bg-gray-100 text-gray-600"
      )}
    >
      {name[0]?.toUpperCase() ?? "?"}
    </div>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("h-3.5 w-3.5 shrink-0 animate-spin", className)}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-20"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="3"
      />
    </svg>
  );
}

function StatusBar({ count }: { count: number }) {
  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-3">
        <span className="text-sm text-muted-foreground">
          {count === 1
            ? "1 agent working..."
            : `${count} agents working concurrently...`}
        </span>
      </div>
    </div>
  );
}

function InputBar({ onSend }: { onSend: (text: string) => void }) {
  const [input, setInput] = useState("");

  return (
    <form
      className="border-t border-border bg-muted/30 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        const text = input.trim();
        if (!text) {
          return;
        }

        onSend(text);
        setInput("");
      }}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <input
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask a question..."
          value={input}
        />
        <button
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={!input.trim()}
          type="submit"
        >
          Send
        </button>
      </div>
    </form>
  );
}

function derivePresentation(events: readonly TailEvent[]): FeedPresentation {
  const committed: FeedEntry[] = [];
  const pendingByAgent = new Map<string, FeedEntry>();
  const agents = new Map<string, AgentColor>([
    ["coordinator", COORDINATOR_COLOR],
  ]);
  let nextWorkerColor = 0;

  for (const event of events) {
    if (event.type === "message.user") {
      committed.push({
        agent: "user",
        name: "You",
        seq: event.seq,
        text: stringValue(payloadOf(event).text),
      });
      continue;
    }

    if (event.type !== "agent.streaming.chunk" && event.type !== "agent.done") {
      continue;
    }

    const payload = payloadOf(event);
    const agent = stringValue(payload.agent);
    if (!agent) {
      continue;
    }

    if (agent !== "coordinator" && !agents.has(agent)) {
      agents.set(
        agent,
        WORKER_COLORS[nextWorkerColor % WORKER_COLORS.length] ?? WORKER_COLORS[0]!
      );
      nextWorkerColor += 1;
    }

    if (event.type === "agent.streaming.chunk") {
      const current = pendingByAgent.get(agent);
      pendingByAgent.set(agent, {
        agent,
        name: stringValue(payload.name) || agent,
        seq: current?.seq ?? event.seq,
        text: `${current?.text ?? ""}${stringValue(payload.delta)}`,
      });
      continue;
    }

    const finished = pendingByAgent.get(agent);
    pendingByAgent.delete(agent);

    if (!finished?.text) {
      continue;
    }

    committed.push({
      agent: finished.agent,
      name: finished.name,
      seq: event.seq,
      text: finished.text,
    });
  }

  return { agents, committed, pending: [...pendingByAgent.values()] };
}

function payloadOf(event: TailEvent): Record<string, unknown> {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
