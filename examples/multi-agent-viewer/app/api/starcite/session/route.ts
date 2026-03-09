import { Starcite, type StarciteSession, type SessionEvent } from "@starcite/sdk";
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getCursor, setCursor } from "@/lib/cursor-store";

// ---------------------------------------------------------------------------
// Config & Types
// ---------------------------------------------------------------------------

interface AgentSpec {
  id: string;
  name: string;
  task: string;
}

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

const EVENT = {
  userMessage: "message.user",
  researchPlan: "research.plan",
  researchFinding: "research.finding",
  synthesis: "synthesis",
  responseCompleted: "openai.response.completed",
  streamingChunk: "agent.streaming.chunk",
} as const;

// ---------------------------------------------------------------------------
// In-memory session registry
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, SessionState>();

// ---------------------------------------------------------------------------
// POST /api/starcite/session
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  const apiKey = requireEnv("STARCITE_API_KEY");
  const openaiKey = requireEnv("OPENAI_API_KEY");
  const baseUrl = process.env.STARCITE_BASE_URL ?? "https://api.starcite.io";
  const coordinatorModel = process.env.OPENAI_COORDINATOR_MODEL ?? "gpt-4o";
  const workerModel = process.env.OPENAI_WORKER_MODEL ?? "gpt-4o-mini";

  const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
  const starcite = new Starcite({ apiKey, baseUrl });

  // Reuse existing in-process session
  if (body.sessionId && activeSessions.has(body.sessionId)) {
    const existing = activeSessions.get(body.sessionId)!;
    const viewer = await starcite.session({
      identity: starcite.user({ id: "web-user" }),
      id: existing.sessionId,
    });
    return NextResponse.json({ sessionId: existing.sessionId, token: viewer.token });
  }

  const userSession = await starcite.session({
    identity: starcite.user({ id: "demo-user" }),
    ...(body.sessionId ? { id: body.sessionId } : {}),
    title: "Research Swarm",
  });
  const sessionId = userSession.id;

  const [coordinatorSession, viewerSession] = await Promise.all([
    starcite.session({ identity: starcite.agent({ id: "coordinator" }), id: sessionId }),
    starcite.session({ identity: starcite.user({ id: "web-user" }), id: sessionId }),
  ]);

  const openai = new OpenAI({ apiKey: openaiKey });

  const state: SessionState = {
    sessionId,
    starcite,
    openai,
    coordinatorModel,
    workerModel,
    coordinator: coordinatorSession,
    workers: new Map(),
    stops: [],
  };

  state.stops.push(bootCoordinator(state));

  activeSessions.set(sessionId, {
    ...state,
    // Override for cleanup tracking
    stops: state.stops,
  });

  return NextResponse.json({ sessionId, token: viewerSession.token });
}

// ---------------------------------------------------------------------------
// DELETE /api/starcite/session — stop all agents for a session
// ---------------------------------------------------------------------------

export async function DELETE(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
  if (!body.sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  const state = activeSessions.get(body.sessionId);
  if (state) {
    for (const stop of state.stops) {
      try { stop(); } catch {}
    }
    activeSessions.delete(body.sessionId);
  }

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Gated event handler with in-flight lock
// ---------------------------------------------------------------------------

function gated(
  sessionId: string,
  agentRole: string,
  session: StarciteSession,
  handler: (event: SessionEvent) => void | Promise<void>,
): () => void {
  const cursor = getCursor(sessionId, agentRole);
  let busy = false;
  let pending: SessionEvent | null = null;

  function process(event: SessionEvent): void {
    const result = handler(event);

    if (result && typeof (result as Promise<void>).then === "function") {
      busy = true;
      (result as Promise<void>).then(
        () => {
          setCursor(sessionId, agentRole, event.seq);
          busy = false;
          if (pending) { const next = pending; pending = null; process(next); }
        },
        (err) => {
          console.error(`[${agentRole}] error:`, err);
          busy = false;
          if (pending) { const next = pending; pending = null; process(next); }
        },
      );
    } else {
      setCursor(sessionId, agentRole, event.seq);
    }
  }

  return session.on(
    "event",
    (event, ctx) => {
      if (ctx.replayed && event.seq <= cursor) return;
      if (busy) { pending = event; return; }
      process(event);
    },
    { replay: true },
  );
}

// ---------------------------------------------------------------------------
// Coordinator — plans research, spawns agents, synthesizes findings
// ---------------------------------------------------------------------------

function bootCoordinator(state: SessionState): () => void {
  const me = state.coordinator;

  // On user message → create research plan and spawn agents
  const off1 = gated(state.sessionId, "coordinator:plan", me, (event) => {
    if (event.type !== EVENT.userMessage) return;

    // Only plan if every existing plan already has a synthesis
    const plans = me.events().filter((e) => e.type === EVENT.researchPlan);
    const syntheses = me.events().filter((e) => e.type === EVENT.synthesis);
    if (plans.length > syntheses.length) return;

    const userText = textOf(event);
    if (!userText) return;

    return (async () => {
      const prevSynthesis = latestText(me, EVENT.synthesis);
      const context = prevSynthesis
        ? `\n\nPrevious synthesis (for context):\n${prevSynthesis}`
        : "";

      // Stream the plan (coordinator uses the smart model)
      const text = await streamToSession(state, {
        session: me,
        model: state.coordinatorModel,
        agent: "coordinator",
        name: "Coordinator",
        stage: "plan",
        instruction: [
          "You are a research coordinator. Analyze the user's question and create a research plan.",
          "Assign 2-4 specialized researchers, each with a unique descriptive name and focused task.",
          `\nUser question: ${userText}${context}`,
          "\nFormat your response as:",
          "A brief intro sentence, then numbered researchers:",
          "1. **Descriptive Agent Name** — Specific research task",
          "2. **Descriptive Agent Name** — Specific research task",
          "3. **Descriptive Agent Name** — Specific research task",
          "\nChoose names that reflect specialization (e.g., 'Market Analyst', 'Technical Architect', 'Historical Researcher').",
          "Keep it concise. Each researcher should cover a genuinely different angle.",
        ].join("\n"),
        originSeq: event.seq,
      });

      // Parse agent specs from the streamed plan
      const agents = parsePlanAgents(text);

      // Spawn worker sessions BEFORE emitting the plan event
      await spawnWorkers(state, agents);

      // Emit the plan — workers are already listening
      await me.append({
        type: EVENT.researchPlan,
        source: "agent",
        payload: {
          originSeq: event.seq,
          text,
          agents: agents.map((a) => ({ id: a.id, name: a.name, task: a.task })),
        },
      });
    })();
  });

  // On research finding → check if all findings are in, then synthesize
  const off2 = gated(state.sessionId, "coordinator:synthesize", me, (event) => {
    if (event.type !== EVENT.researchFinding) return;

    const latestPlan = [...me.events()].reverse().find((e) => e.type === EVENT.researchPlan);
    if (!latestPlan) return;
    const planSeq = latestPlan.seq;

    // Already synthesized for this plan?
    if (me.events().some((e) => e.type === EVENT.synthesis && pNum(e, "planSeq") === planSeq)) return;

    // Count findings vs expected
    const p = eventPayload(latestPlan);
    const expectedCount = Array.isArray(p.agents) ? (p.agents as AgentSpec[]).length : 0;
    const findings = me.events().filter(
      (e) => e.type === EVENT.researchFinding && pNum(e, "planSeq") === planSeq,
    );
    if (findings.length < expectedCount) return;

    // Get original user question
    const originSeq = pNum(latestPlan, "originSeq");
    const userMsg = originSeq != null ? me.events().find((e) => e.seq === originSeq) : undefined;
    const userText = userMsg ? textOf(userMsg) : firstUserMessage(me) ?? "";

    return (async () => {
      const findingsText = findings
        .map((f) => {
          const name = pStr(f, "name") ?? pStr(f, "agent") ?? "Researcher";
          return `### ${name}\n${textOf(f)}`;
        })
        .join("\n\n");

      const text = await streamToSession(state, {
        session: me,
        model: state.coordinatorModel,
        agent: "coordinator",
        name: "Coordinator",
        stage: "synthesize",
        instruction: [
          "Synthesize these research findings into a comprehensive, well-structured answer.",
          `\nOriginal question: ${userText}`,
          `\nResearch findings:\n${findingsText}`,
          "\nProvide a clear, authoritative synthesis that integrates insights from all researchers.",
          "Use markdown. Be thorough but not repetitive. 300-500 words.",
          "End with a brief takeaway or recommendation.",
        ].join("\n"),
        originSeq: event.seq,
      });

      await me.append({
        type: EVENT.synthesis,
        source: "agent",
        payload: { planSeq, text },
      });
    })();
  });

  return () => { off1(); off2(); };
}

// ---------------------------------------------------------------------------
// Dynamic worker spawning
// ---------------------------------------------------------------------------

async function spawnWorkers(state: SessionState, agents: AgentSpec[]): Promise<void> {
  for (const spec of agents) {
    if (state.workers.has(spec.id)) continue;

    const session = await state.starcite.session({
      identity: state.starcite.agent({ id: spec.id }),
      id: state.sessionId,
    });
    state.workers.set(spec.id, session);
    state.stops.push(bootWorker(state, spec.id, spec.name, session));
  }
}

// ---------------------------------------------------------------------------
// Worker — researches one angle based on coordinator's assignment
// ---------------------------------------------------------------------------

function bootWorker(
  state: SessionState,
  agentId: string,
  agentName: string,
  session: StarciteSession,
): () => void {
  return gated(state.sessionId, agentId, session, (event) => {
    if (event.type !== EVENT.researchPlan) return;

    const planSeq = event.seq;

    // Already produced a finding for this plan?
    if (session.events().some((e) =>
      e.type === EVENT.researchFinding && pNum(e, "planSeq") === planSeq,
    )) return;

    // Find my assignment in the plan
    const p = eventPayload(event);
    const agents = Array.isArray(p.agents) ? (p.agents as AgentSpec[]) : [];
    const mySpec = agents.find((a) => a.id === agentId);
    if (!mySpec) return;

    // Get user's original question
    const originSeq = pNum(event, "originSeq");
    const userMsg = originSeq != null
      ? session.events().find((e) => e.seq === originSeq)
      : undefined;
    const userText = userMsg ? textOf(userMsg) : "";

    return (async () => {
      const text = await streamToSession(state, {
        session,
        model: state.workerModel,
        agent: agentId,
        name: mySpec.name,
        stage: "research",
        instruction: [
          `You are ${mySpec.name}, a research specialist.`,
          `\nOriginal question: ${userText}`,
          `\nYour assigned research task: ${mySpec.task}`,
          "\nProvide a thorough, well-structured analysis.",
          "Include specific details, examples, and evidence where relevant.",
          "Use markdown formatting. 200-400 words.",
        ].join("\n"),
        originSeq: planSeq,
      });

      await session.append({
        type: EVENT.researchFinding,
        source: "agent",
        payload: { planSeq, agent: agentId, name: mySpec.name, task: mySpec.task, text },
      });
    })();
  });
}

// ---------------------------------------------------------------------------
// Streaming helper
// ---------------------------------------------------------------------------

async function streamToSession(
  state: SessionState,
  input: {
    session: StarciteSession;
    model: string;
    agent: string;
    name: string;
    stage: string;
    instruction: string;
    originSeq: number;
  },
): Promise<string> {
  const { session, model, agent, name, stage, instruction, originSeq } = input;

  const sysInstruction = agent === "coordinator"
    ? stage === "plan"
      ? "You are an intelligent research coordinator. Break questions into distinct angles and assign specialized researchers. Be strategic about coverage — each angle should reveal something unique."
      : "You are a research coordinator synthesizing findings from specialists. Create a cohesive, authoritative answer integrating all perspectives. Clear structure, markdown."
    : `You are ${name}, a focused research specialist. Provide thorough, evidence-based analysis. Specific examples and data. Markdown formatting.`;

  const stream = await state.openai.responses.create({
    model,
    stream: true,
    instructions: sysInstruction,
    input: [{ role: "user", content: [{ type: "input_text", text: instruction }] }],
  });

  let accumulated = "";
  let buffer = "";
  const FLUSH = 60;

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      const delta = (event as unknown as { delta: string }).delta;
      if (typeof delta !== "string") continue;
      accumulated += delta;
      buffer += delta;
      if (buffer.length >= FLUSH) {
        session.append({
          type: EVENT.streamingChunk, source: "agent",
          payload: { agent, name, stage, originSeq, delta: buffer, accumulated },
        }).catch(() => {});
        buffer = "";
      }
    }
  }

  if (buffer.length > 0) {
    await session.append({
      type: EVENT.streamingChunk, source: "agent",
      payload: { agent, name, stage, originSeq, delta: buffer, accumulated },
    }).catch(() => {});
  }

  const text = accumulated.trim();
  if (!text) throw new Error(`Empty response from ${agent}`);

  await session.append({
    type: EVENT.responseCompleted,
    source: "openai",
    payload: { agent, name, originSeq, stage, text },
  });

  return text;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse "1. **Agent Name** — Task description" from coordinator's plan. */
function parsePlanAgents(text: string): AgentSpec[] {
  const matches = [...text.matchAll(/^\d+\.\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)/gm)];
  const agents = matches
    .map((m) => ({
      id: slugify(m[1] ?? ""),
      name: (m[1] ?? "").trim(),
      task: (m[2] ?? "").trim(),
    }))
    .filter((a) => a.id && a.name);

  if (agents.length === 0) {
    return [
      { id: "analyst-1", name: "Analyst 1", task: "General analysis" },
      { id: "analyst-2", name: "Analyst 2", task: "Alternative perspective" },
      { id: "analyst-3", name: "Analyst 3", task: "Critical evaluation" },
    ];
  }

  return agents.slice(0, 5);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventPayload(event: SessionEvent): Record<string, unknown> {
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    return event.payload as Record<string, unknown>;
  }
  return {};
}

function pStr(event: SessionEvent, key: string): string | undefined {
  const v = eventPayload(event)[key];
  return typeof v === "string" ? v : undefined;
}

function pNum(event: SessionEvent, key: string): number | undefined {
  const v = eventPayload(event)[key];
  return typeof v === "number" ? v : undefined;
}

function textOf(event: SessionEvent): string | undefined {
  if (typeof event.payload === "string") return event.payload;
  return pStr(event, "text");
}

function latestText(session: StarciteSession, type: string): string | undefined {
  const e = [...session.events()].reverse().find((c) => c.type === type);
  return e ? textOf(e) : undefined;
}

function firstUserMessage(session: StarciteSession): string | undefined {
  const e = session.events().find((c) => c.type === EVENT.userMessage);
  return e ? textOf(e) : undefined;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key}`);
  return v;
}
