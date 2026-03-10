import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { Starcite, type StarciteSession, type SessionEvent } from "@starcite/sdk";
import { NextResponse } from "next/server";

// -- Event types --

const EV = {
  user: "message.user",
  plan: "research.plan",
  finding: "research.finding",
  synthesis: "synthesis",
  chunk: "agent.streaming.chunk",
  done: "agent.done",
} as const;

interface Agent { id: string; name: string; task: string }

// -- Active sessions (in-memory, lost on server restart) --

const active = new Map<string, (() => void)[]>();

// -- Routes --

export async function POST(request: Request) {
  const starcite = new Starcite({
    apiKey: env("STARCITE_API_KEY"),
    baseUrl: process.env.STARCITE_BASE_URL ?? "https://api.starcite.io",
  });
  const model = createOpenAI({ apiKey: env("OPENAI_API_KEY") })(process.env.OPENAI_MODEL ?? "gpt-4o-mini");

  const body = (await request.json().catch(() => ({}))) as { sessionId?: string };

  // Reconnect to existing session
  if (body.sessionId && active.has(body.sessionId)) {
    const session = await starcite.session({ identity: starcite.user({ id: "demo-user" }), id: body.sessionId });
    return NextResponse.json({ sessionId: body.sessionId, token: session.token });
  }

  // New session
  const userSession = await starcite.session({
    identity: starcite.user({ id: "demo-user" }),
    ...(body.sessionId ? { id: body.sessionId } : {}),
    title: "Research Swarm",
  });
  const id = userSession.id;
  const coordinator = await starcite.session({ identity: starcite.agent({ id: "coordinator" }), id });

  const stops: (() => void)[] = [];
  stops.push(
    onUserMessage(coordinator, model, starcite, id, stops),
    onAllFindings(coordinator, model),
  );
  active.set(id, stops);

  return NextResponse.json({ sessionId: id, token: userSession.token });
}

export async function DELETE(request: Request) {
  const { sessionId } = (await request.json().catch(() => ({}))) as { sessionId?: string };
  const stops = sessionId ? active.get(sessionId) : undefined;
  if (stops) { stops.forEach((fn) => { try { fn(); } catch {} }); active.delete(sessionId!); }
  return NextResponse.json({ ok: true });
}

// -- Coordinator: user question → plan → spawn workers --

function onUserMessage(
  coordinator: StarciteSession, model: Parameters<typeof streamText>[0]["model"],
  starcite: Starcite, sessionId: string, stops: (() => void)[],
): () => void {
  return listen(coordinator, async (event) => {
    if (event.type !== EV.user) return;
    const question = pl(event).text as string ?? "";
    if (!question) return;

    const planText = await streamToSession(model, coordinator, {
      agent: "coordinator", name: "Coordinator", originSeq: event.seq,
      system: "You are a research coordinator. Break questions into distinct research angles.",
      prompt: `Break this into 2-4 research angles. Assign each to a named specialist.\n\nQuestion: ${question}\n\nFormat: brief intro, then:\n1. **Specialist Name** — Research task`,
    });

    const agents = parsePlan(planText);
    await coordinator.append({ type: EV.plan, source: "agent", payload: { originSeq: event.seq, text: planText, agents } });

    for (const spec of agents) {
      const worker = await starcite.session({ identity: starcite.agent({ id: spec.id }), id: sessionId });
      stops.push(onPlanAssigned(worker, model, spec));
    }
  });
}

// -- Coordinator: all findings in → synthesize --

function onAllFindings(coordinator: StarciteSession, model: Parameters<typeof streamText>[0]["model"]): () => void {
  return listen(coordinator, async (event) => {
    if (event.type !== EV.finding) return;

    const plan = [...coordinator.events()].reverse().find((e) => e.type === EV.plan);
    if (!plan) return;

    const agents = pl(plan).agents as Agent[] ?? [];
    const findings = coordinator.events().filter((e) => e.type === EV.finding && pl(e).planSeq === plan.seq);
    if (findings.length < agents.length) return;
    if (coordinator.events().some((e) => e.type === EV.synthesis && pl(e).planSeq === plan.seq)) return;

    const question = userTextAt(coordinator, pl(plan).originSeq as number);
    const summary = findings.map((f) => `### ${pl(f).name}\n${pl(f).text}`).join("\n\n");

    const text = await streamToSession(model, coordinator, {
      agent: "coordinator", name: "Coordinator", originSeq: event.seq,
      system: "Synthesize research findings into a clear, structured answer with markdown.",
      prompt: `Original question: ${question}\n\nFindings:\n${summary}\n\nSynthesize into 300-500 words. End with a takeaway.`,
    });

    await coordinator.append({ type: EV.synthesis, source: "agent", payload: { planSeq: plan.seq, text } });
  });
}

// -- Worker: plan assigned → research → finding --

function onPlanAssigned(worker: StarciteSession, model: Parameters<typeof streamText>[0]["model"], spec: Agent): () => void {
  return listen(worker, async (event) => {
    if (event.type !== EV.plan) return;
    if (worker.events().some((e) => e.type === EV.finding && pl(e).planSeq === event.seq)) return;

    const me = (pl(event).agents as Agent[] ?? []).find((a) => a.id === spec.id);
    if (!me) return;

    const question = userTextAt(worker, pl(event).originSeq as number);

    const text = await streamToSession(model, worker, {
      agent: spec.id, name: me.name, originSeq: event.seq,
      system: `You are ${me.name}, a research specialist. Evidence-based analysis, specific examples, markdown.`,
      prompt: `Task: ${me.task}\nQuestion: ${question}\n\nProvide thorough analysis with examples. Use markdown. 200-400 words.`,
    });

    await worker.append({
      type: EV.finding, source: "agent",
      payload: { planSeq: event.seq, agent: spec.id, name: me.name, task: me.task, text },
    });
  });
}

// -- Stream LLM response, emit chunks to session --

async function streamToSession(
  model: Parameters<typeof streamText>[0]["model"],
  session: StarciteSession,
  opts: { agent: string; name: string; system: string; prompt: string; originSeq: number },
): Promise<string> {
  const { agent, name, originSeq } = opts;

  const result = streamText({ model, system: opts.system, prompt: opts.prompt });

  let text = "";
  let buf = "";

  for await (const delta of result.textStream) {
    text += delta;
    buf += delta;
    if (buf.length >= 60) {
      session.append({ type: EV.chunk, source: "agent", payload: { agent, name, originSeq, delta: buf, accumulated: text } }).catch(() => {});
      buf = "";
    }
  }

  if (buf) {
    await session.append({ type: EV.chunk, source: "agent", payload: { agent, name, originSeq, delta: buf, accumulated: text } }).catch(() => {});
  }

  text = text.trim();
  if (!text) throw new Error(`Empty response from ${agent}`);

  await session.append({ type: EV.done, source: "agent", payload: { agent, name, originSeq } });
  return text;
}

// -- Helpers --

function listen(session: StarciteSession, handler: (event: SessionEvent) => void | Promise<void>): () => void {
  let busy = false;
  let queued: SessionEvent | null = null;

  function run(event: SessionEvent) {
    const result = handler(event);
    if (!(result instanceof Promise)) return;
    busy = true;
    const done = () => { busy = false; if (queued) { const next = queued; queued = null; run(next); } };
    result.then(done, (err) => { console.error(err); done(); });
  }

  return session.on("event", (event) => {
    if (busy) { queued = event; return; }
    run(event);
  }, { replay: false });
}

function pl(event: SessionEvent): Record<string, unknown> {
  const p = event.payload;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

function userTextAt(session: StarciteSession, seq: number | undefined): string {
  if (seq == null) return "";
  const msg = session.events().find((e) => e.seq === seq);
  return msg ? (pl(msg).text as string ?? "") : "";
}

function parsePlan(text: string): Agent[] {
  const matches = [...text.matchAll(/^\d+\.\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)/gm)];
  const agents = matches
    .map((m) => ({ id: m[1]!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), name: m[1]!.trim(), task: m[2]!.trim() }))
    .filter((a) => a.id && a.name);
  return agents.length > 0 ? agents.slice(0, 5) : [
    { id: "analyst-1", name: "Analyst 1", task: "General analysis" },
    { id: "analyst-2", name: "Analyst 2", task: "Alternative perspective" },
  ];
}

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key}`);
  return v;
}
