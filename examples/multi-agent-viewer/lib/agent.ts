import { openai } from "@ai-sdk/openai";
import { streamText, tool } from "ai";
import { type StarciteSession, type TailEvent } from "@starcite/sdk";
import { z } from "zod";
import { starcite } from "./starcite";

type AgentBootstrapState = typeof globalThis & {
  __starciteMultiAgentViewerStartedClients?: WeakSet<object>;
};
type AgentDescriptor = { agent: string; name: string };
type WorkerFinding = { name: string; text: string };

const coordinatorModel = openai(
  process.env.OPENAI_COORDINATOR_MODEL ??
    process.env.OPENAI_MODEL ??
    "gpt-4o-mini"
);
const workerModel = openai(process.env.OPENAI_WORKER_MODEL ?? "gpt-4.1-nano");

const startAgentInput = z.object({
  name: z.string(),
  prompt: z.string(),
});
type WorkerAssignment = z.infer<typeof startAgentInput> & { id: string };

const coordinatorAgent = {
  agent: "coordinator",
  name: "Coordinator",
} as const;
const coordinatorIdentity = starcite.agent({ id: "coordinator" });
const bootstrapState = globalThis as AgentBootstrapState;
const startedClients =
  bootstrapState.__starciteMultiAgentViewerStartedClients ??
  (bootstrapState.__starciteMultiAgentViewerStartedClients =
    new WeakSet<object>());

// Deduplicate bootstrap per SDK client instance so HMR can replace the client
// without permanently blocking re-registration.
if (!startedClients.has(starcite)) {
  startedClients.add(starcite);
  starcite.on("session.created", (event) => {
    void attachCoordinator(event.session_id);
  });
}

async function attachCoordinator(sessionId: string): Promise<void> {
  const session = await starcite.session({
    identity: coordinatorIdentity,
    id: sessionId,
    title: "Research Swarm",
  });

  let running = false;

  session.on("event", async (event) => {
    if (event.type !== "message.user" || running) {
      return;
    }

    const question = messageText(event);
    if (!question) {
      return;
    }

    running = true;
    try {
      await runCoordinatorTurn(session, question);
    } catch (error) {
      await appendAgentMessage(
        session,
        coordinatorAgent,
        formatAgentError(coordinatorAgent.name, error)
      );
    } finally {
      running = false;
    }
  });
}

async function runCoordinatorTurn(
  session: StarciteSession,
  question: string
): Promise<void> {
  const launched: Promise<WorkerFinding>[] = [];

  await appendAgentMessage(
    session,
    coordinatorAgent,
    "I'll look at this from a few angles, then synthesize a final answer."
  );

  const assignments = streamText({
    model: coordinatorModel,
    system: [
      "You are a research coordinator.",
      "You must use start_agent two to four times for every user question.",
      "Each specialist should investigate one distinct angle.",
      "A separate synthesis pass will run after the specialists finish, so do not give the final answer yet.",
    ].join(" "),
    prompt: question,
    tools: {
      start_agent: tool({
        description: "Launch a specialist agent for one research angle.",
        inputSchema: startAgentInput,
        execute: async ({ name, prompt }) => {
          launched.push(
            runWorker(session.id, {
              id: workerId(name, launched.length + 1),
              name,
              prompt,
            })
          );
          return { ok: true };
        },
      }),
    },
  });

  const assignmentText = await streamAgentText(
    session,
    coordinatorAgent,
    assignments.textStream
  );

  const findings = await Promise.all(launched);
  if (findings.length === 0) {
    if (!assignmentText) {
      await appendAgentMessage(
        session,
        coordinatorAgent,
        "Coordinator could not launch specialists for this request."
      );
    }
    return;
  }

  const summary = streamText({
    model: coordinatorModel,
    system: [
      "You are a research coordinator.",
      "Synthesize the specialist findings into one direct answer.",
      "Be decisive and concise.",
      "Do not ask follow-up questions.",
    ].join(" "),
    prompt: summaryPrompt(question, findings),
  });

  const summaryText = await streamAgentText(
    session,
    coordinatorAgent,
    summary.textStream
  );
  if (!summaryText) {
    await appendAgentMessage(
      session,
      coordinatorAgent,
      "Coordinator could not produce a final answer."
    );
  }
}

async function runWorker(
  sessionId: string,
  assignment: WorkerAssignment
): Promise<WorkerFinding> {
  const session = await starcite.session({
    identity: starcite.agent({ id: assignment.id }),
    id: sessionId,
  });
  const agent: AgentDescriptor = {
    agent: assignment.id,
    name: assignment.name,
  };

  try {
    const result = streamText({
      model: workerModel,
      system: `You are ${assignment.name}. Focus on your specialty and be concise, concrete, and useful.`,
      prompt: assignment.prompt,
    });

    const text = await streamAgentText(session, agent, result.textStream);
    if (text) {
      return { name: assignment.name, text };
    }

    await appendAgentMessage(session, agent, "No output.");
    return { name: assignment.name, text: "No output." };
  } catch (error) {
    const text = formatAgentError(assignment.name, error);
    await appendAgentMessage(session, agent, text);
    return { name: assignment.name, text };
  }
}

async function appendAgentChunk(
  session: StarciteSession,
  agent: AgentDescriptor,
  delta: string
): Promise<void> {
  await session.append({
    type: "agent.streaming.chunk",
    source: "agent",
    payload: {
      ...agent,
      delta,
    },
  });
}

async function appendAgentDone(
  session: StarciteSession,
  agent: AgentDescriptor
): Promise<void> {
  await session.append({
    type: "agent.done",
    source: "agent",
    payload: agent,
  });
}

async function appendAgentMessage(
  session: StarciteSession,
  agent: AgentDescriptor,
  text: string
): Promise<void> {
  await appendAgentChunk(session, agent, text);
  await appendAgentDone(session, agent);
}

async function streamAgentText(
  session: StarciteSession,
  agent: AgentDescriptor,
  stream: AsyncIterable<string>
): Promise<string> {
  let text = "";

  try {
    for await (const delta of stream) {
      text += delta;
      await appendAgentChunk(session, agent, delta);
    }

    return text.trim();
  } finally {
    await appendAgentDone(session, agent);
  }
}

function formatAgentError(name: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${name} could not finish this step: ${message}`;
}

function summaryPrompt(
  question: string,
  findings: readonly WorkerFinding[]
): string {
  return [
    `User question: ${question}`,
    "",
    "Specialist findings:",
    ...findings.map(
      (finding) => `${finding.name}:\n${finding.text || "No output."}`
    ),
  ].join("\n\n");
}

function workerId(name: string, index: number): string {
  return `${slugify(name)}-${index}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

function messageText(event: TailEvent): string {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }

  return typeof payload.text === "string" ? payload.text.trim() : "";
}
