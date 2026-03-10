"use client";

import {
  LocalStorageSessionStore,
  Starcite,
  type SessionEvent,
  type StarciteSession,
} from "@starcite/sdk";
import { useStarciteSession } from "@starcite/react";
import { memo, useCallback, useRef, useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// --- Types ---

type ConnectionState = "idle" | "connecting" | "ready";

interface AgentColor { bg: string; text: string }
interface AgentInfo { id: string; name: string; color: AgentColor }
interface FeedEntry { agent: string; name: string; text: string; seq: number; type: string }

// --- Colors ---

const COORDINATOR_COLOR: AgentColor = { bg: "bg-amber-50", text: "text-amber-700" };
const WORKER_COLORS: AgentColor[] = [
  { bg: "bg-blue-50", text: "text-blue-700" },
  { bg: "bg-violet-50", text: "text-violet-700" },
  { bg: "bg-emerald-50", text: "text-emerald-700" },
  { bg: "bg-rose-50", text: "text-rose-700" },
  { bg: "bg-cyan-50", text: "text-cyan-700" },
];

const FEED_TYPES = new Set(["message.user", "research.plan", "research.finding", "synthesis"]);

// --- Page ---

export default function Page() {
  const [starcite] = useState(() => new Starcite({
    baseUrl: process.env.NEXT_PUBLIC_STARCITE_BASE_URL ?? "https://api.starcite.io",
    store: typeof window === "undefined" ? undefined : new LocalStorageSessionStore({ keyPrefix: "starcite:multi-agent-viewer" }),
  }));

  const [sessionId, setSessionId] = useState<string>();
  const [session, setSession] = useState<StarciteSession>();
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string>();
  const bootedRef = useRef(false);

  // Boot once
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const existing = new URLSearchParams(window.location.search).get("sessionId")?.trim();
    void connect(existing || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async (existingId?: string) => {
    try {
      setConnState("connecting");
      setError(undefined);
      const res = await fetch("/api/starcite/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(existingId ? { sessionId: existingId } : {}),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Failed (${res.status})`);
      const data = await res.json() as { sessionId: string; token: string };
      setSessionId(data.sessionId);
      setSession(starcite.session({ token: data.token }));
      setConnState("ready");
      const url = new URL(window.location.href);
      url.searchParams.set("sessionId", data.sessionId);
      window.history.replaceState({}, "", url);
    } catch (err) {
      setConnState("idle");
      setError(err instanceof Error ? err.message : "Failed");
    }
  }, [starcite]);

  // useStarciteSession handles subscription + debounced refresh (inert when session is null)
  const { events, append } = useStarciteSession({
    session,
    onError: (err) => setError(err.message),
  });

  const sendMessage = useCallback(async (text: string) => {
    await append({ text, type: "message.user", source: "user" });
  }, [append]);

  // --- Agent registry (stable ref, only grows) ---
  const agentMapRef = useRef(new Map<string, AgentInfo>());
  const agentMap = agentMapRef.current;
  if (!agentMap.has("coordinator")) {
    agentMap.set("coordinator", { id: "coordinator", name: "Coordinator", color: COORDINATOR_COLOR });
  }
  for (const ev of events) {
    discoverAgent(ev, agentMap);
  }

  // --- Committed (append-only ref) + Pending (derived each render) ---
  const feedState = useRef({ committed: [] as FeedEntry[], seenSeqs: new Set<number>(), settled: new Set<string>() });
  const { committed, pending } = deriveFeed(events, feedState.current, agentMap);
  const hasContent = committed.length > 0 || pending.length > 0;
  const hasPending = pending.length > 0;
  const hasAsked = committed.some((e) => e.type === "message.user");

  // --- Render ---

  if (!sessionId) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="text-center space-y-3">
          {error ? (
            <>
              <p className="text-sm text-destructive">{error}</p>
              <button className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                onClick={() => { bootedRef.current = false; void connect(); }}>Retry</button>
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
      <Header connState={connState} sessionId={sessionId} />
      <Feed committed={committed} pending={pending} agentMap={agentMap} hasContent={hasContent} />
      {hasPending ? (
        <PendingBar count={pending.length} sessionId={sessionId} />
      ) : !hasAsked ? (
        <InputBar onSend={sendMessage} />
      ) : null}
    </div>
  );
}

// --- Header ---

function Header({ connState, sessionId }: { connState: ConnectionState; sessionId: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3">
      <div className={cn("h-2 w-2 rounded-full",
        connState === "ready" && "bg-emerald-500",
        connState === "connecting" && "bg-blue-500 animate-pulse",
      )} />
      <span className="text-sm font-semibold">Research Swarm</span>
      <span className="text-xs font-mono text-muted-foreground ml-auto">{sessionId.slice(0, 20)}...</span>
    </div>
  );
}

// --- Feed ---

function useAutoScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < lastTop.current - 10) pinned.current = false;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) pinned.current = true;
      lastTop.current = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => { if (pinned.current) endRef.current?.scrollIntoView({ block: "end" }); });

  return { scrollRef, endRef };
}

function Feed({ committed, pending, agentMap, hasContent }: {
  committed: FeedEntry[];
  pending: FeedEntry[];
  agentMap: Map<string, AgentInfo>;
  hasContent: boolean;
}) {
  const { scrollRef, endRef } = useAutoScroll();

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
        {committed.map((entry) =>
          entry.agent === "user" || entry.agent === "coordinator"
            ? <FullCard key={`c-${entry.seq}`} entry={entry} agentMap={agentMap} />
            : <WorkerCard key={`c-${entry.seq}`} entry={entry} agentMap={agentMap} />,
        )}
        {pending.map((entry) =>
          entry.agent === "coordinator"
            ? <FullCard key={`s-${entry.agent}`} entry={entry} agentMap={agentMap} streaming />
            : <WorkerCard key={`s-${entry.agent}`} entry={entry} agentMap={agentMap} streaming />,
        )}
        <div ref={endRef} className="h-px" />
      </div>
    </div>
  );
}

// --- Full Card (user, coordinator) ---

const FullCard = memo(function FullCard({ entry, agentMap, streaming }: {
  entry: FeedEntry;
  agentMap: Map<string, AgentInfo>;
  streaming?: boolean;
}) {
  const isUser = entry.agent === "user";
  const color = agentMap.get(entry.agent)?.color;

  return (
    <div className={cn("rounded-lg border px-4 py-3", isUser ? "border-border bg-muted/30" : "border-transparent")}>
      <CardHeader name={entry.name} color={color} isUser={isUser} spinning={streaming} />
      <Prose>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
        {streaming && <BlinkCursor />}
      </Prose>
    </div>
  );
});

// --- Worker Card (collapsed with optional streaming tail preview) ---

const WorkerCard = memo(function WorkerCard({ entry, agentMap, streaming }: {
  entry: FeedEntry;
  agentMap: Map<string, AgentInfo>;
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const c = agentMap.get(entry.agent)?.color ?? WORKER_COLORS[0]!;

  return (
    <div className={cn("rounded-lg border border-border overflow-hidden", streaming && c.bg + "/20")}>
      <CollapseHeader name={entry.name} color={c} expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
        {streaming ? <Spinner className={c.text} /> : <CheckIcon />}
      </CollapseHeader>
      {(expanded || streaming) && (
        <div className={cn("px-4", expanded ? "pb-4" : "pb-2")}>
          {expanded ? (
            <Prose small>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
              {streaming && <BlinkCursor />}
            </Prose>
          ) : (
            <div className="relative overflow-hidden" style={{ maxHeight: 80 }}>
              <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white to-transparent z-10 dark:from-gray-950" />
              <div className="flex flex-col-reverse" style={{ maxHeight: 80 }}>
                <Prose small>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
                  <BlinkCursor />
                </Prose>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// --- Shared UI ---

function CardHeader({ name, color, isUser, spinning }: {
  name: string; color?: AgentColor; isUser?: boolean; spinning?: boolean;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <Avatar name={name} color={color} isUser={isUser} />
      <span className={cn("text-xs font-semibold", color?.text ?? "text-gray-600")}>
        {isUser ? "You" : name}
      </span>
      {spinning && color && <Spinner className={color.text} />}
    </div>
  );
}

function CollapseHeader({ name, color, expanded, onToggle, children }: {
  name: string; color: AgentColor; expanded: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onToggle}
      className="flex w-full items-center gap-2 px-4 py-2 text-left cursor-pointer hover:bg-muted/40 transition-colors">
      <Avatar name={name} color={color} />
      <span className={cn("text-xs font-semibold truncate", color.text)}>{name}</span>
      {children}
      <svg className={cn("h-3.5 w-3.5 text-muted-foreground ml-auto transition-transform", expanded && "rotate-180")}
        viewBox="0 0 16 16" fill="currentColor">
        <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
      </svg>
    </button>
  );
}

function Avatar({ name, color, isUser }: { name: string; color?: AgentColor; isUser?: boolean }) {
  return (
    <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0",
      color ? [color.bg, color.text] : "bg-gray-100 text-gray-600")}>
      {isUser ? "U" : name[0]?.toUpperCase() ?? "?"}
    </div>
  );
}

function Prose({ children, small }: { children: React.ReactNode; small?: boolean }) {
  return (
    <div className={cn(
      "prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      small && "text-[13px] leading-relaxed",
    )}>
      {children}
    </div>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("h-3.5 w-3.5 animate-spin shrink-0", className)} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-emerald-500" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

function BlinkCursor() {
  return <span className="ml-0.5 inline-block h-4 w-1.5 bg-foreground/70 align-text-bottom" style={{ animation: "blink 1s infinite" }} />;
}

// --- Pending Bar ---

function PendingBar({ count, sessionId }: { count: number; sessionId: string }) {
  const [stopping, setStopping] = useState(false);

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-3">
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-1.5 w-1.5 rounded-full bg-amber-500"
                style={{ animation: `pulse 1.5s ease-in-out ${i * 0.2}s infinite` }} />
            ))}
          </div>
          <span className="text-sm text-muted-foreground">
            {count === 1 ? "1 agent working..." : `${count} agents working concurrently...`}
          </span>
        </div>
        <button type="button" disabled={stopping}
          onClick={() => {
            setStopping(true);
            fetch("/api/starcite/session", {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId }),
            }).catch(() => {});
          }}
          className="rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
          {stopping ? "Stopping..." : "Stop"}
        </button>
      </div>
    </div>
  );
}

// --- Input Bar ---

function InputBar({ onSend }: { onSend: (text: string) => Promise<void> }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async () => {
    const t = input.trim();
    if (!t || sending) return;
    setSending(true);
    await onSend(t);
    setInput("");
    setSending(false);
  };

  return (
    <form className="border-t border-border bg-muted/30 px-4 py-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <input className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={sending} onChange={(e) => setInput(e.target.value)} placeholder="Ask a question..." value={input} />
        <button className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={!input.trim() || sending} type="submit">Send</button>
      </div>
    </form>
  );
}

// --- Feed derivation ---

interface FeedState { committed: FeedEntry[]; seenSeqs: Set<number>; settled: Set<string> }

function deriveFeed(events: readonly SessionEvent[], state: FeedState, agentMap: Map<string, AgentInfo>) {
  const streams = new Map<string, { name: string; text: string; originSeq: number }>();

  for (const ev of events) {
    if (ev.type === "openai.response.completed") {
      const p = pl(ev);
      state.settled.add(`${p.agent}:${p.originSeq}`);
    } else if (ev.type === "agent.streaming.chunk") {
      const p = pl(ev);
      if (typeof p.agent === "string") {
        streams.set(p.agent as string, {
          name: (p.name as string) ?? (p.agent as string),
          text: p.accumulated as string,
          originSeq: p.originSeq as number,
        });
      }
    }
    if (FEED_TYPES.has(ev.type) && !state.seenSeqs.has(ev.seq)) {
      state.seenSeqs.add(ev.seq);
      const agent = resolveAgent(ev);
      state.committed.push({
        agent, seq: ev.seq, type: ev.type,
        name: agent === "user" ? "You" : (pl(ev).name as string) ?? agentMap.get(agent)?.name ?? agent,
        text: textOf(ev) ?? "",
      });
    }
  }

  const pending: FeedEntry[] = [];
  for (const [agent, s] of streams) {
    if (!state.settled.has(`${agent}:${s.originSeq}`)) {
      pending.push({ agent, name: s.name, text: s.text, seq: s.originSeq, type: "agent.streaming.chunk" });
    }
  }

  return { committed: state.committed, pending };
}

// --- Helpers ---

const AGENT_EVENT_TYPES = new Set(["agent.streaming.chunk", "research.finding", "openai.response.completed"]);

function discoverAgent(event: SessionEvent, map: Map<string, AgentInfo>) {
  if (event.type === "research.plan") {
    const agents = pl(event).agents as { id: string; name: string }[] | undefined;
    if (agents) {
      for (const a of agents) {
        if (!map.has(a.id)) {
          map.set(a.id, { id: a.id, name: a.name, color: WORKER_COLORS[(map.size - 1) % WORKER_COLORS.length]! });
        }
      }
    }
    return;
  }
  if (AGENT_EVENT_TYPES.has(event.type)) {
    const p = pl(event);
    const id = p.agent as string | undefined;
    const name = p.name as string | undefined;
    if (id && name && id !== "coordinator" && !map.has(id)) {
      map.set(id, { id, name, color: WORKER_COLORS[(map.size - 1) % WORKER_COLORS.length]! });
    }
  }
}

function resolveAgent(event: SessionEvent): string {
  if (event.actor.startsWith("agent:")) return event.actor.replace("agent:", "");
  if (event.actor.startsWith("user:")) return "user";
  const agent = pl(event).agent;
  return typeof agent === "string" ? agent : "user";
}

function pl(event: SessionEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function textOf(event: SessionEvent): string | undefined {
  if (typeof event.payload === "string") return event.payload;
  const t = pl(event).text;
  return typeof t === "string" ? t : undefined;
}
