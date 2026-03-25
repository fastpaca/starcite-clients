"use client";

import { LocalStorageSessionStore, Starcite, type SessionEvent, type StarciteSession } from "@starcite/sdk";
import { useStarciteSession } from "@starcite/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { cn } from "@/lib/utils";

// -- Types --

interface AgentColor { bg: string; text: string; accent: string }
interface FeedEntry { agent: string; name: string; text: string; seq: number; type: string }

// -- Colors --

const COORDINATOR_COLOR: AgentColor = { bg: "bg-amber-50", text: "text-amber-700", accent: "border-amber-200" };
const WORKER_COLORS: AgentColor[] = [
  { bg: "bg-blue-50", text: "text-blue-700", accent: "border-blue-200" },
  { bg: "bg-violet-50", text: "text-violet-700", accent: "border-violet-200" },
  { bg: "bg-emerald-50", text: "text-emerald-700", accent: "border-emerald-200" },
  { bg: "bg-rose-50", text: "text-rose-700", accent: "border-rose-200" },
  { bg: "bg-cyan-50", text: "text-cyan-700", accent: "border-cyan-200" },
];

// -- Page --

export default function Page() {
  const [starcite] = useState(() => new Starcite({
    baseUrl: process.env.NEXT_PUBLIC_STARCITE_BASE_URL ?? "https://api.starcite.io",
    store: typeof window === "undefined" ? undefined : new LocalStorageSessionStore({ keyPrefix: "starcite:multi-agent-viewer" }),
  }));

  const [sessionId, setSessionId] = useState<string>();
  const [session, setSession] = useState<StarciteSession>();
  const [error, setError] = useState<string>();
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const existing = new URLSearchParams(window.location.search).get("sessionId")?.trim();
    void connect(existing || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async (existingId?: string) => {
    try {
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
      const url = new URL(window.location.href);
      url.searchParams.set("sessionId", data.sessionId);
      window.history.replaceState({}, "", url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }, [starcite]);

  const { events, append } = useStarciteSession({ session, onError: (err) => setError(err.message) });
  const sendMessage = useCallback((text: string) => append({ text, type: "message.user", source: "user" }), [append]);

  const agents = discoverAgents(events);
  const { committed, pending } = deriveFeed(events);

  if (!sessionId) {
    return (
      <div className="flex h-dvh items-center justify-center">
        {error ? (
          <div className="text-center space-y-3">
            <p className="text-sm text-destructive">{error}</p>
            <button className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => { bootedRef.current = false; void connect(); }}>Retry</button>
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
        <span className="text-xs font-mono text-muted-foreground ml-auto">{sessionId.slice(0, 20)}...</span>
      </header>

      <Feed committed={committed} pending={pending} agents={agents} />

      {pending.length > 0 ? (
        <StatusBar count={pending.length} />
      ) : (
        <InputBar onSend={sendMessage} />
      )}
    </div>
  );
}

// -- Feed (auto-scrolling via use-stick-to-bottom) --

function Feed({ committed, pending, agents }: {
  committed: FeedEntry[]; pending: FeedEntry[]; agents: Map<string, AgentColor>;
}) {
  if (committed.length === 0 && pending.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Ask a question and watch the research swarm investigate it from multiple angles.
      </div>
    );
  }

  return (
    <StickToBottom className="flex-1 overflow-y-hidden" resize="smooth" role="log">
      <StickToBottom.Content className="mx-auto max-w-3xl space-y-3 p-4">
        {committed.map((entry) =>
          entry.agent === "user" || entry.agent === "coordinator"
            ? <FullCard key={`c-${entry.seq}`} entry={entry} color={agents.get(entry.agent)} />
            : <WorkerCard key={`c-${entry.seq}`} entry={entry} color={agents.get(entry.agent) ?? WORKER_COLORS[0]!} />,
        )}
        {pending.map((entry) =>
          entry.agent === "coordinator"
            ? <FullCard key={`s-${entry.agent}`} entry={entry} color={agents.get(entry.agent)} streaming />
            : <WorkerCard key={`s-${entry.agent}`} entry={entry} color={agents.get(entry.agent) ?? WORKER_COLORS[0]!} streaming />,
        )}
      </StickToBottom.Content>
      <ScrollToBottom />
    </StickToBottom>
  );
}

function ScrollToBottom() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button onClick={() => scrollToBottom()} type="button"
      className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm hover:bg-muted transition-colors">
      Scroll to bottom
    </button>
  );
}

// -- Cards --

const FullCard = memo(function FullCard({ entry, color, streaming }: {
  entry: FeedEntry; color?: AgentColor; streaming?: boolean;
}) {
  const isUser = entry.agent === "user";
  return (
    <div className={cn("rounded-lg border px-4 py-3", isUser ? "border-border bg-muted/30" : "border-transparent")}>
      <div className="mb-1.5 flex items-center gap-2">
        <Avatar name={entry.name} color={color} />
        <span className={cn("text-xs font-semibold", color?.text ?? "text-gray-600")}>{isUser ? "You" : entry.name}</span>
        {streaming && <Spinner className={color?.text} />}
      </div>
      <Markdown text={entry.text} />
    </div>
  );
});

const WorkerCard = memo(function WorkerCard({ entry, color, streaming }: {
  entry: FeedEntry; color: AgentColor; streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("rounded-lg border overflow-hidden", streaming ? color.accent : "border-border")}>
      <button type="button" onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left cursor-pointer hover:bg-muted/40 transition-colors">
        <Avatar name={entry.name} color={color} />
        <span className={cn("text-xs font-semibold truncate", color.text)}>{entry.name}</span>
        {streaming ? <Spinner className={color.text} /> : <span className="text-emerald-500 text-xs">Done</span>}
        <span className={cn("ml-auto text-muted-foreground text-xs transition-transform", expanded && "rotate-180")}>&#x25BC;</span>
      </button>
      {(expanded || streaming) && (
        <div className={cn("px-4", expanded ? "pb-4" : "pb-2")}>
          {expanded ? (
            <Markdown text={entry.text} small />
          ) : (
            <StreamingTail text={entry.text} />
          )}
        </div>
      )}
    </div>
  );
});

function StreamingTail({ text }: { text: string }) {
  return (
    <div className="relative overflow-hidden" style={{ maxHeight: 80 }}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white to-transparent z-10 dark:from-gray-950" />
      <div className="flex flex-col-reverse" style={{ maxHeight: 80 }}>
        <Markdown text={text} small />
      </div>
    </div>
  );
}

// -- Shared UI --

const Markdown = memo(function Markdown({ text, small }: { text: string; small?: boolean }) {
  return (
    <Streamdown
      className={cn(
        "prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        small && "text-[13px] leading-relaxed",
      )}
    >
      {text}
    </Streamdown>
  );
});

function Avatar({ name, color }: { name: string; color?: AgentColor }) {
  return (
    <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0",
      color ? [color.bg, color.text] : "bg-gray-100 text-gray-600")}>
      {name[0]?.toUpperCase() ?? "?"}
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

// -- Status Bar --

function StatusBar({ count }: { count: number }) {
  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-3">
        <span className="text-sm text-muted-foreground">
          {count === 1 ? "1 agent working..." : `${count} agents working concurrently...`}
        </span>
      </div>
    </div>
  );
}

// -- Input Bar --

function InputBar({ onSend }: { onSend: (text: string) => void }) {
  const [input, setInput] = useState("");

  return (
    <form className="border-t border-border bg-muted/30 px-4 py-3" onSubmit={(e) => { e.preventDefault(); const t = input.trim(); if (t) { onSend(t); setInput(""); } }}>
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <input className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          onChange={(e) => setInput(e.target.value)} placeholder="Ask a question..." value={input} />
        <button className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={!input.trim()} type="submit">Send</button>
      </div>
    </form>
  );
}

// -- Feed derivation (pure function of events) --

function deriveFeed(events: readonly SessionEvent[]) {
  const committed: FeedEntry[] = [];
  const streams = new Map<string, FeedEntry>();

  for (const ev of events) {
    if (ev.type === "message.user") {
      const agent = ev.actor.startsWith("agent:")
        ? ev.actor.slice(6)
        : ev.actor.startsWith("user:")
          ? "user"
          : ((pl(ev).agent as string) ?? "user");
      committed.push({
        agent,
        seq: ev.seq,
        type: ev.type,
        name: agent === "user" ? "You" : ((pl(ev).name as string) ?? agent),
        text: (pl(ev).text as string) ?? "",
      });
      continue;
    }

    if (ev.type === "agent.streaming.chunk") {
      const p = pl(ev);
      const agent = typeof p.agent === "string" ? p.agent : "agent";
      const current = streams.get(agent);
      streams.set(agent, {
        agent,
        name: (p.name as string) ?? agent,
        text: `${current?.text ?? ""}${typeof p.delta === "string" ? p.delta : ""}`,
        seq: current?.seq ?? ev.seq,
        type: ev.type,
      });
      continue;
    }

    if (ev.type === "agent.done") {
      const p = pl(ev);
      const agent = typeof p.agent === "string" ? p.agent : "";
      if (!agent) {
        continue;
      }
      const stream = streams.get(agent);
      streams.delete(agent);
      if (stream?.text) {
        committed.push({
          agent: stream.agent,
          name: stream.name,
          text: stream.text,
          seq: ev.seq,
          type: "agent.output",
        });
      }
    }
  }

  return { committed, pending: [...streams.values()] };
}

function discoverAgents(events: readonly SessionEvent[]): Map<string, AgentColor> {
  const map = new Map<string, AgentColor>();
  map.set("coordinator", COORDINATOR_COLOR);
  let nextWorker = 0;
  for (const ev of events) {
    if (ev.type !== "agent.streaming.chunk" && ev.type !== "agent.done") {
      continue;
    }
    const id = pl(ev).agent;
    if (typeof id !== "string" || id === "coordinator" || map.has(id)) {
      continue;
    }
    map.set(id, WORKER_COLORS[nextWorker % WORKER_COLORS.length]!);
    nextWorker++;
  }
  return map;
}

function pl(event: SessionEvent): Record<string, unknown> {
  const p = event.payload;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}
