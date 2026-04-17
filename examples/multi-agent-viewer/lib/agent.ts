import { openai } from "@ai-sdk/openai";
import {
  SessionAgent,
  SessionAgentSupervisor,
} from "@starcite/session-supervisor";
import { streamText, tool } from "ai";
import { type TailEvent, type StarciteSession } from "@starcite/sdk";
import { z } from "zod";
import { starcite } from "./starcite";

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

const coordinatorAgent = {
  agent: "coordinator",
  name: "Coordinator",
} as const;

type WorkerAssignment = z.infer<typeof startAgentInput> & { id: string };
type WorkerFinding = { name: string; text: string };

class CoordinatorSessionAgent extends SessionAgent<StarciteSession> {
  async receive(event: TailEvent): Promise<void> {
    if (event.type !== "message.user") {
      return;
    }

    const question = messageText(event);
    if (!question) {
      return;
    }

    await this.runCoordinatorTurn(question);
  }

  private async runCoordinatorTurn(question: string): Promise<void> {
    const launched: Promise<WorkerFinding>[] = [];

    await this.appendCoordinatorDelta(
      "I'll look at this from a few angles, then synthesize a final answer."
    );
    await this.appendCoordinatorDone();

    const result = streamText({
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
              this.runWorker({
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

    for await (const delta of result.textStream) {
      await this.appendCoordinatorDelta(delta);
    }

    await this.appendCoordinatorDone();

    const findings = await Promise.all(launched);
    if (findings.length === 0) {
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

    for await (const delta of summary.textStream) {
      await this.appendCoordinatorDelta(delta);
    }

    await this.appendCoordinatorDone();
  }

  private async runWorker(
    assignment: WorkerAssignment
  ): Promise<WorkerFinding> {
    const session = await starcite.session({
      identity: starcite.agent({ id: assignment.id }),
      id: this.sessionId,
    });

    const result = streamText({
      model: workerModel,
      system: `You are ${assignment.name}. Focus on your specialty and be concise, concrete, and useful.`,
      prompt: assignment.prompt,
    });

    let text = "";

    for await (const delta of result.textStream) {
      text += delta;
      await session.append({
        type: "agent.streaming.chunk",
        source: "agent",
        payload: {
          agent: assignment.id,
          name: assignment.name,
          delta,
        },
      });
    }

    await session.append({
      type: "agent.done",
      source: "agent",
      payload: {
        agent: assignment.id,
        name: assignment.name,
      },
    });

    return { name: assignment.name, text: text.trim() };
  }

  private async appendCoordinatorDelta(delta: string): Promise<void> {
    await this.session.append({
      type: "agent.streaming.chunk",
      source: "agent",
      payload: {
        ...coordinatorAgent,
        delta,
      },
    });
  }

  private async appendCoordinatorDone(): Promise<void> {
    await this.session.append({
      type: "agent.done",
      source: "agent",
      payload: coordinatorAgent,
    });
  }
}

const supervisor = new SessionAgentSupervisor({
  Agent: CoordinatorSessionAgent,
  agent: starcite.agent({ id: "coordinator" }),
  starcite,
});

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

void supervisor.start().catch((error: unknown) => {
  console.error("[multi-agent-viewer] failed to start session supervisor", error);
});
