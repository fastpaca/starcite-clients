import { Starcite, type StarciteSession, type SessionEvent } from "@starcite/sdk";
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getCursor, setCursor } from "@/lib/cursor-store";

// --- Types ---

interface AgentSpec { id: string; name: string; task: string }

interface SessionState {
  sessionId: string;
  starcite: Starcite;
  openai: OpenAI;
  coordinatorModel: string;
  workerModel: string;
  coordinator: StarciteSession;
  workers: Map<string, StarciteSession>;
  stops: (() => void)[];
}

const EV = {
  userMessage: "message.user",
  plan: "research.plan",
  finding: "research.finding",
  synthesis: "synthesis",
  completed: "openai.response.completed",
  chunk: "agent.streaming.chunk",
} as const;

// --- In-memory session registry ---

const sessions = new Map<string, SessionState>();

// --- POST: create or reconnect ---

export async function POST(request: Request) {
  const apiKey = env("STARCITE_API_KEY");
  const openaiKey = env("OPENAI_API_KEY");
  const baseUrl = process.env.STARCITE_BASE_URL ?? "https://api.starcite.io";
  const coordinatorModel = process.env.OPENAI_COORDINATOR_MODEL ?? "gpt-4o";
  const workerModel = process.env.OPENAI_WORKER_MODEL ?? "gpt-4o-mini";

  const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
  const starcite = new Starcite({ apiKey, baseUrl });

  if (body.sessionId && sessions.has(body.sessionId)) {
    const viewer = await starcite.session({ identity: starcite.user({ id: "web-user" }), id: body.sessionId });
    return NextResponse.json({ sessionId: body.sessionId, token: viewer.token });
  }

  const userSession = await starcite.session({
    identity: starcite.user({ id: "demo-user" }),
    ...(body.sessionId ? { id: body.sessionId } : {}),
    title: "Research Swarm",
  });
  const id = userSession.id;

  const [coordinator, viewer] = await Promise.all([
    starcite.session({ identity: starcite.agent({ id: "coordinator" }), id }),
    starcite.session({ identity: starcite.user({ id: "web-user" }), id }),
  ]);

  const state: SessionState = {
    sessionId: id,
    starcite,
    openai: new OpenAI({ apiKey: openaiKey }),
    coordinatorModel,
    workerModel,
    coordinator,
    workers: new Map(),
    stops: [],
  };

  state.stops.push(bootCoordinator(state));
  sessions.set(id, state);

  return NextResponse.json({ sessionId: id, token: viewer.token });
}

// --- DELETE: stop all agents ---

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
  if (!body.sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  const state = sessions.get(body.sessionId);
  if (state) {
    state.stops.forEach((stop) => { try { stop(); } catch {} });
    sessions.delete(body.sessionId);
  }

  return NextResponse.json({ ok: true });
}

// --- Gated event handler (skip replayed, serialize async work) ---

function gated(
  sessionId: string,
  role: string,
  session: StarciteSession,
  handler: (event: SessionEvent) => void | Promise<void>,
): () => void {
  const cursor = getCursor(sessionId, role);
  let busy = false;
  let queued: SessionEvent | null = null;

  function run(event: SessionEvent) {
    const result = handler(event);
    if (result instanceof Promise) {
      busy = true;
      const done = () => {
        setCursor(sessionId, role, event.seq);
        busy = false;
        if (queued) { const next = queued; queued = null; run(next); }
      };
      result.then(done, (err) => { console.error(`[${role}]`, err); done(); });
    } else {
      setCursor(sessionId, role, event.seq);
    }
  }

  return session.on("event", (event, ctx) => {
    if (ctx.replayed && event.seq <= cursor) return;
    if (busy) { queued = event; return; }
    run(event);
  }, { replay: true });
}

// --- Coordinator: plan + synthesize ---

function bootCoordinator(state: SessionState): () => void {
  const me = state.coordinator;

  const offPlan = gated(state.sessionId, "coordinator:plan", me, (event) => {
    if (event.type !== EV.userMessage) return;

    const userText = payload(event).text as string | undefined ?? (typeof event.payload === "string" ? event.payload : "");
    if (!userText) return;

    return (async () => {
      const text = await streamLLM(state, me, "coordinator", "Coordinator", "plan", state.coordinatorModel, [
        "You are a research coordinator. Break the user's question into 2-4 distinct research angles.",
        "Assign each to a specialist with a unique descriptive name.",
        `\nUser question: ${userText}`,
        "\nFormat: brief intro, then numbered list:",
        "1. **Agent Name** — Research task",
        "\nNames should reflect specialization. Keep it concise.",
      ].join("\n"), event.seq);

      const agents = parsePlan(text);
      await spawnWorkers(state, agents);

      await me.append({
        type: EV.plan, source: "agent",
        payload: { originSeq: event.seq, text, agents },
      });
    })();
  });

  const offSynth = gated(state.sessionId, "coordinator:synthesize", me, (event) => {
    if (event.type !== EV.finding) return;

    const plan = [...me.events()].reverse().find((e) => e.type === EV.plan);
    if (!plan) return;

    const p = payload(plan);
    const planSeq = plan.seq;
    const expected = Array.isArray(p.agents) ? (p.agents as AgentSpec[]).length : 0;
    const found = me.events().filter((e) => e.type === EV.finding && payload(e).planSeq === planSeq);
    if (found.length < expected) return;
    if (me.events().some((e) => e.type === EV.synthesis && payload(e).planSeq === planSeq)) return;

    const originSeq = typeof p.originSeq === "number" ? p.originSeq : undefined;
    const userMsg = originSeq != null ? me.events().find((e) => e.seq === originSeq) : undefined;
    const userText = userMsg ? (payload(userMsg).text as string ?? "") : "";

    return (async () => {
      const findings = found.map((f) => `### ${payload(f).name ?? "Researcher"}\n${payload(f).text}`).join("\n\n");

      const text = await streamLLM(state, me, "coordinator", "Coordinator", "synthesize", state.coordinatorModel, [
        "Synthesize these research findings into a comprehensive, well-structured answer.",
        `\nOriginal question: ${userText}`,
        `\nFindings:\n${findings}`,
        "\nIntegrate all perspectives. Use markdown. 300-500 words.",
        "End with a brief takeaway.",
      ].join("\n"), event.seq);

      await me.append({ type: EV.synthesis, source: "agent", payload: { planSeq, text } });
    })();
  });

  return () => { offPlan(); offSynth(); };
}

// --- Workers ---

async function spawnWorkers(state: SessionState, agents: AgentSpec[]) {
  for (const spec of agents) {
    if (state.workers.has(spec.id)) continue;
    const session = await state.starcite.session({ identity: state.starcite.agent({ id: spec.id }), id: state.sessionId });
    state.workers.set(spec.id, session);
    state.stops.push(bootWorker(state, spec, session));
  }
}

function bootWorker(state: SessionState, spec: AgentSpec, session: StarciteSession): () => void {
  return gated(state.sessionId, spec.id, session, (event) => {
    if (event.type !== EV.plan) return;

    const planSeq = event.seq;
    if (session.events().some((e) => e.type === EV.finding && payload(e).planSeq === planSeq)) return;

    const agents = payload(event).agents as AgentSpec[] | undefined ?? [];
    const mySpec = agents.find((a) => a.id === spec.id);
    if (!mySpec) return;

    const originSeq = payload(event).originSeq as number | undefined;
    const userMsg = originSeq != null ? session.events().find((e) => e.seq === originSeq) : undefined;
    const userText = userMsg ? (payload(userMsg).text as string ?? "") : "";

    return (async () => {
      const text = await streamLLM(state, session, spec.id, mySpec.name, "research", state.workerModel, [
        `You are ${mySpec.name}, a research specialist.`,
        `\nOriginal question: ${userText}`,
        `\nYour task: ${mySpec.task}`,
        "\nProvide thorough, well-structured analysis with specific examples.",
        "Use markdown. 200-400 words.",
      ].join("\n"), planSeq);

      await session.append({
        type: EV.finding, source: "agent",
        payload: { planSeq, agent: spec.id, name: mySpec.name, task: mySpec.task, text },
      });
    })();
  });
}

// --- LLM streaming ---

async function streamLLM(
  state: SessionState,
  session: StarciteSession,
  agent: string,
  name: string,
  stage: string,
  model: string,
  instruction: string,
  originSeq: number,
): Promise<string> {
  const systemPrompt = agent === "coordinator"
    ? stage === "plan"
      ? "You are an intelligent research coordinator. Break questions into distinct angles and assign specialized researchers."
      : "You are a research coordinator synthesizing specialist findings. Clear structure, markdown."
    : `You are ${name}, a focused research specialist. Evidence-based analysis, specific examples, markdown.`;

  const stream = await state.openai.responses.create({
    model,
    stream: true,
    instructions: systemPrompt,
    input: [{ role: "user", content: [{ type: "input_text", text: instruction }] }],
  });

  let accumulated = "";
  let buffer = "";

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      const delta = (event as unknown as { delta: string }).delta;
      if (typeof delta !== "string") continue;
      accumulated += delta;
      buffer += delta;
      if (buffer.length >= 60) {
        session.append({
          type: EV.chunk, source: "agent",
          payload: { agent, name, stage, originSeq, delta: buffer, accumulated },
        }).catch(() => {});
        buffer = "";
      }
    }
  }

  if (buffer) {
    await session.append({
      type: EV.chunk, source: "agent",
      payload: { agent, name, stage, originSeq, delta: buffer, accumulated },
    }).catch(() => {});
  }

  const text = accumulated.trim();
  if (!text) throw new Error(`Empty response from ${agent}`);

  await session.append({
    type: EV.completed, source: "openai",
    payload: { agent, name, originSeq, stage, text },
  });

  return text;
}

// --- Helpers ---

function parsePlan(text: string): AgentSpec[] {
  const matches = [...text.matchAll(/^\d+\.\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)/gm)];
  const agents = matches
    .map((m) => ({ id: slugify(m[1]!), name: m[1]!.trim(), task: m[2]!.trim() }))
    .filter((a) => a.id && a.name);

  return agents.length > 0
    ? agents.slice(0, 5)
    : [
        { id: "analyst-1", name: "Analyst 1", task: "General analysis" },
        { id: "analyst-2", name: "Analyst 2", task: "Alternative perspective" },
        { id: "analyst-3", name: "Analyst 3", task: "Critical evaluation" },
      ];
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function payload(event: SessionEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key}`);
  return v;
}
