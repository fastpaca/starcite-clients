"use client";

import {
  LocalStorageSessionStore,
  Starcite,
  type SessionEvent,
  type StarciteSession,
} from "@starcite/sdk";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectionState = "idle" | "connecting" | "ready" | "reconnecting";

interface AgentColor {
  bg: string;
  text: string;
  dot: string;
}

interface AgentInfo {
  id: string;
  name: string;
  color: AgentColor;
}

interface FeedEntry {
  kind: "committed" | "streaming";
  agent: string;
  name: string;
  text: string;
  seq: number;
  type: string;
}

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------

const COORDINATOR_COLOR: AgentColor = {
  bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-500",
};

const WORKER_COLORS: AgentColor[] = [
  { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-500" },
  { bg: "bg-violet-50", text: "text-violet-700", dot: "bg-violet-500" },
  { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" },
  { bg: "bg-rose-50", text: "text-rose-700", dot: "bg-rose-500" },
  { bg: "bg-cyan-50", text: "text-cyan-700", dot: "bg-cyan-500" },
  { bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-500" },
];

const FEED_TYPES = new Set(["message.user", "research.plan", "research.finding", "synthesis"]);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Page() {
  const [starcite] = useState(
    () =>
      new Starcite({
        baseUrl: process.env.NEXT_PUBLIC_STARCITE_BASE_URL ?? "https://api.starcite.io",
        store:
          typeof window === "undefined"
            ? undefined
            : new LocalStorageSessionStore({ keyPrefix: "starcite:multi-agent-viewer" }),
      }),
  );

  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [session, setSession] = useState<StarciteSession>();
  const [events, setEvents] = useState<readonly SessionEvent[]>([]);
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string>();
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const existingId = new URLSearchParams(window.location.search).get("sessionId")?.trim();
    void createOrReconnect(existingId || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session) {
      startTransition(() => setEvents([]));
      return;
    }
    setConnState("ready");
    startTransition(() => setEvents([...session.events()]));
    const off1 = session.on("event", () => {
      startTransition(() => {
        setConnState("ready");
        setEvents([...session.events()]);
      });
    }, { replay: true });
    const off2 = session.on("error", (err) => {
      setConnState("reconnecting");
      setError(err.message);
    });
    return () => { off1(); off2(); session.disconnect(); };
  }, [session]);

  const createOrReconnect = useCallback(
    async (existingId?: string) => {
      try {
        setConnState("connecting");
        setError(undefined);
        const res = await fetch("/api/starcite/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(existingId ? { sessionId: existingId } : {}),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
          throw new Error(body?.error ?? `Session creation failed (${res.status})`);
        }
        const data = (await res.json()) as { sessionId: string; token: string };
        setActiveSessionId(data.sessionId);
        setSession(starcite.session({ token: data.token }));
        const url = new URL(window.location.href);
        url.searchParams.set("sessionId", data.sessionId);
        window.history.replaceState({}, "", url);
      } catch (err) {
        setConnState("idle");
        setError(err instanceof Error ? err.message : "Session creation failed");
      }
    },
    [starcite],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (!session) return;
      // Ensure backend session is alive (re-establishes after stop)
      await fetch("/api/starcite/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: activeSessionId }),
      }).catch(() => {});
      await session.append({ text, type: "message.user", source: "user" });
    },
    [session, activeSessionId],
  );

  // -------------------------------------------------------------------------
  // Stable agent registry — only grows, never recreates
  // -------------------------------------------------------------------------

  const agentMapRef = useRef(new Map<string, AgentInfo>());
  const agentMap = agentMapRef.current;

  if (!agentMap.has("coordinator")) {
    agentMap.set("coordinator", { id: "coordinator", name: "Coordinator", color: COORDINATOR_COLOR });
  }

  // -------------------------------------------------------------------------
  // Committed / Pending split
  // -------------------------------------------------------------------------

  // Committed entries: append-only ref. Once an event becomes committed it's frozen.
  const committedRef = useRef<FeedEntry[]>([]);
  const committedSeqsRef = useRef(new Set<number>());

  // Settled streams: tracks which agent:originSeq pairs are done streaming
  const settledRef = useRef(new Set<string>());

  // Scan new events — populate agents, committed entries, settled set
  for (const event of events) {
    // Agent discovery
    if (event.type === "research.plan") {
      const p = eventPayload(event);
      if (Array.isArray(p.agents)) {
        for (const a of p.agents as { id: string; name: string }[]) {
          if (typeof a.id === "string" && typeof a.name === "string" && !agentMap.has(a.id)) {
            const idx = agentMap.size - 1;
            agentMap.set(a.id, { id: a.id, name: a.name, color: WORKER_COLORS[idx % WORKER_COLORS.length]! });
          }
        }
      }
    }
    if (event.type === "agent.streaming.chunk" || event.type === "research.finding" || event.type === "openai.response.completed") {
      const p = eventPayload(event);
      if (typeof p.agent === "string" && typeof p.name === "string" && p.agent !== "coordinator" && !agentMap.has(p.agent as string)) {
        const idx = agentMap.size - 1;
        agentMap.set(p.agent as string, { id: p.agent as string, name: p.name as string, color: WORKER_COLORS[idx % WORKER_COLORS.length]! });
      }
    }

    // Track settled streams
    if (event.type === "openai.response.completed") {
      const p = eventPayload(event);
      const agent = typeof p.agent === "string" ? p.agent : "";
      const originSeq = typeof p.originSeq === "number" ? p.originSeq : -1;
      settledRef.current.add(`${agent}:${originSeq}`);
    }

    // Append committed entries (feed events only, deduplicated by seq)
    if (FEED_TYPES.has(event.type) && !committedSeqsRef.current.has(event.seq)) {
      committedSeqsRef.current.add(event.seq);
      const agent = resolveAgent(event);
      const p = eventPayload(event);
      const agentInfo = agentMap.get(agent);
      committedRef.current.push({
        kind: "committed",
        agent,
        name: agent === "user" ? "You" : typeof p.name === "string" ? p.name as string : agentInfo?.name ?? agent,
        text: textFromEvent(event) ?? "",
        seq: event.seq,
        type: event.type,
      });
    }
  }

  // Pending = streaming chunks not yet settled
  const pending: FeedEntry[] = [];
  const streamByAgent = new Map<string, { name: string; text: string; originSeq: number }>();
  for (const event of events) {
    if (event.type === "agent.streaming.chunk") {
      const p = eventPayload(event);
      if (typeof p.agent === "string" && typeof p.accumulated === "string") {
        streamByAgent.set(p.agent as string, {
          name: typeof p.name === "string" ? p.name as string : p.agent as string,
          text: p.accumulated as string,
          originSeq: p.originSeq as number,
        });
      }
    }
  }
  for (const [agent, { name, text, originSeq }] of streamByAgent) {
    if (settledRef.current.has(`${agent}:${originSeq}`)) continue;
    pending.push({ kind: "streaming", agent, name, text, seq: originSeq, type: "agent.streaming.chunk" });
  }

  const committed = committedRef.current;
  const hasContent = committed.length > 0 || pending.length > 0;
  const hasPending = pending.length > 0;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!activeSessionId) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="text-center space-y-3">
          {error ? (
            <>
              <p className="text-sm text-destructive">{error}</p>
              <button
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                onClick={() => { bootedRef.current = false; void createOrReconnect(); }}
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              <p className="text-sm text-muted-foreground">Creating session...</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr_auto] overflow-hidden">
      <Header connState={connState} sessionId={activeSessionId} />
      <FeedView committed={committed} pending={pending} agentMap={agentMap} hasContent={hasContent} />
      {hasPending ? (
        <PendingBar count={pending.length} sessionId={activeSessionId} />
      ) : committed.length === 0 ? (
        <InputBar onSend={sendMessage} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ connState, sessionId }: { connState: ConnectionState; sessionId: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3">
      <div className={cn(
        "h-2 w-2 rounded-full",
        connState === "ready" && "bg-emerald-500",
        connState === "reconnecting" && "bg-amber-500 animate-pulse",
        connState === "connecting" && "bg-blue-500 animate-pulse",
      )} />
      <span className="text-sm font-semibold">Research Swarm</span>
      <span className="text-xs font-mono text-muted-foreground ml-auto">{sessionId.slice(0, 20)}...</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feed View
// ---------------------------------------------------------------------------

function FeedView({
  committed,
  pending,
  agentMap,
  hasContent,
}: {
  committed: FeedEntry[];
  pending: FeedEntry[];
  agentMap: Map<string, AgentInfo>;
  hasContent: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const lastScrollTop = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < lastScrollTop.current - 10) userScrolledUp.current = true;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) userScrolledUp.current = false;
      lastScrollTop.current = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (userScrolledUp.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  });

  if (!hasContent) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Ask a question and watch the research swarm investigate it from multiple angles.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto" role="log">
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        {/* Committed — frozen, never re-render */}
        {committed.map((entry) =>
          entry.agent === "user" || entry.agent === "coordinator" ? (
            <CommittedCard key={`c-${entry.seq}`} entry={entry} agentMap={agentMap} />
          ) : (
            <CollapsedCard key={`c-${entry.seq}`} entry={entry} agentMap={agentMap} />
          ),
        )}

        {/* Pending — currently streaming */}
        {pending.map((entry) =>
          entry.agent === "coordinator" ? (
            <StreamingFullCard key={`s-${entry.agent}`} entry={entry} agentMap={agentMap} />
          ) : (
            <StreamingCard key={`s-${entry.agent}`} entry={entry} agentMap={agentMap} />
          ),
        )}

        <div ref={endRef} className="h-px" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Committed Card — frozen, memoized, never re-renders
// ---------------------------------------------------------------------------

const CommittedCard = memo(function CommittedCard({
  entry,
  agentMap,
}: {
  entry: FeedEntry;
  agentMap: Map<string, AgentInfo>;
}) {
  const isUser = entry.agent === "user";
  const color = agentMap.get(entry.agent)?.color;

  return (
    <div className={cn(
      "rounded-lg border px-4 py-3",
      isUser ? "border-border bg-muted/30" : "border-transparent",
    )}>
      <AgentHeader name={entry.name} color={color} isUser={isUser} label={formatEventType(entry.type)} />
      <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Collapsed Card — worker committed output, always collapsed with expand toggle
// ---------------------------------------------------------------------------

const CollapsedCard = memo(function CollapsedCard({
  entry,
  agentMap,
}: {
  entry: FeedEntry;
  agentMap: Map<string, AgentInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = agentMap.get(entry.agent)?.color;
  const c = color ?? WORKER_COLORS[0]!;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left cursor-pointer hover:bg-muted/40 transition-colors"
      >
        <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0", c.bg, c.text)}>
          {entry.name[0]?.toUpperCase()}
        </div>
        <span className={cn("text-xs font-semibold truncate", c.text)}>{entry.name}</span>
        <svg className="h-3.5 w-3.5 shrink-0 text-emerald-500" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
        </svg>
        <div className="ml-auto shrink-0">
          <svg
            className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-180")}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground/90 text-[13px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Streaming Full Card — coordinator streaming, shows full text with cursor
// ---------------------------------------------------------------------------

function StreamingFullCard({
  entry,
  agentMap,
}: {
  entry: FeedEntry;
  agentMap: Map<string, AgentInfo>;
}) {
  const color = agentMap.get(entry.agent)?.color;

  return (
    <div className="rounded-lg border border-transparent px-4 py-3">
      <AgentHeader name={entry.name} color={color} label="Streaming" spinning />
      <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
        <BlinkCursor />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Streaming Card — worker streaming, compact collapsed with tail fade
// ---------------------------------------------------------------------------

function StreamingCard({
  entry,
  agentMap,
}: {
  entry: FeedEntry;
  agentMap: Map<string, AgentInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = agentMap.get(entry.agent)?.color;
  const c = color ?? WORKER_COLORS[0]!;

  return (
    <div className={cn("rounded-lg border border-border overflow-hidden", c.bg + "/20")}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left cursor-pointer hover:bg-muted/40 transition-colors"
      >
        <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0", c.bg, c.text)}>
          {entry.name[0]?.toUpperCase()}
        </div>
        <span className={cn("text-xs font-semibold truncate", c.text)}>{entry.name}</span>
        <svg className={cn("h-3.5 w-3.5 animate-spin shrink-0", c.text)} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div className="ml-auto shrink-0">
          <svg
            className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-180")}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </div>
      </button>
      <div className={cn("px-4", expanded ? "pb-4" : "pb-2")}>
        {expanded ? (
          <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground/90 text-[13px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
            <BlinkCursor />
          </div>
        ) : (
          <div className="relative overflow-hidden" style={{ maxHeight: 80 }}>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white to-transparent z-10 dark:from-gray-950" />
            <div className="flex flex-col-reverse" style={{ maxHeight: 80 }}>
              <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground/90 text-[13px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
                <BlinkCursor />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function AgentHeader({ name, color, isUser, label, spinning }: { name: string; color?: AgentColor; isUser?: boolean; label?: string; spinning?: boolean }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      {color ? (
        <>
          <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold", color.bg, color.text)}>
            {name[0]?.toUpperCase()}
          </div>
          <span className={cn("text-xs font-semibold", color.text)}>{name}</span>
        </>
      ) : isUser ? (
        <>
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-600">U</div>
          <span className="text-xs font-semibold text-gray-600">You</span>
        </>
      ) : (
        <>
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-600">
            {name[0]?.toUpperCase() ?? "?"}
          </div>
          <span className="text-xs font-semibold text-gray-600">{name}</span>
        </>
      )}
      {label && <span className="text-[10px] text-muted-foreground">{label}</span>}
      {spinning && color && (
        <svg className={cn("h-3.5 w-3.5 animate-spin", color.text)} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

function BlinkCursor() {
  return (
    <span
      className="ml-0.5 inline-block h-4 w-1.5 bg-foreground/70 align-text-bottom"
      style={{ animation: "blink 1s infinite" }}
    />
  );
}

// ---------------------------------------------------------------------------
// Pending Bar
// ---------------------------------------------------------------------------

function PendingBar({ count, sessionId }: { count: number; sessionId: string }) {
  const [stopping, setStopping] = useState(false);

  const handleStop = async () => {
    setStopping(true);
    await fetch("/api/starcite/session", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  };

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-3">
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-amber-500"
                style={{ animation: `pulse 1.5s ease-in-out ${i * 0.2}s infinite` }}
              />
            ))}
          </div>
          <span className="text-sm text-muted-foreground">
            {count === 1 ? "1 agent working..." : `${count} agents working concurrently...`}
          </span>
        </div>
        <button
          type="button"
          disabled={stopping}
          onClick={() => void handleStop()}
          className="rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
        >
          {stopping ? "Stopping..." : "Stop"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Input Bar
// ---------------------------------------------------------------------------

function InputBar({ onSend }: { onSend: (text: string) => Promise<void> }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const handleSubmit = async () => {
    const t = input.trim();
    if (!t || sending) return;
    setSending(true);
    await onSend(t);
    setInput("");
    setSending(false);
  };

  return (
    <form className="border-t border-border bg-muted/30 px-4 py-3" onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }}>
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <input
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question..."
          value={input}
        />
        <button
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={!input.trim() || sending}
          type="submit"
        >
          Send
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAgent(event: SessionEvent): string {
  if (event.actor.startsWith("agent:")) return event.actor.replace("agent:", "");
  if (event.actor.startsWith("user:")) return "user";
  const p = eventPayload(event);
  if (typeof p.agent === "string") return p.agent;
  return "user";
}

function eventPayload(event: SessionEvent): Record<string, unknown> {
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) return event.payload as Record<string, unknown>;
  return {};
}

function textFromEvent(event: SessionEvent): string | undefined {
  if (typeof event.payload === "string") return event.payload;
  const p = eventPayload(event);
  return typeof p.text === "string" ? p.text as string : undefined;
}

function formatEventType(type: string): string {
  return type.replace(/\./g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
