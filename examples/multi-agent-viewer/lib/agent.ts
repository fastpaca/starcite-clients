import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool } from "ai";
import { Starcite, type SessionEvent, type StarciteSession } from "@starcite/sdk";
import { z } from "zod";

export const starcite = new Starcite({
  apiKey: process.env.STARCITE_API_KEY!,
  baseUrl: process.env.STARCITE_BASE_URL ?? "https://api.starcite.io",
});

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const coordinatorModel = openai(
  process.env.OPENAI_COORDINATOR_MODEL ??
    process.env.OPENAI_MODEL ??
    "gpt-4o-mini"
);
const workerModel = openai(process.env.OPENAI_WORKER_MODEL ?? "gpt-4.1-nano");

const startAgentInput = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
});

const agentStartedEventType = "agent.started";
const coordinatorSummaryStartedEventType = "coordinator.summary.started";
const coordinatorSummaryDoneEventType = "coordinator.summary.done";

starcite.on("session.created", (event) => {
  void (async () => {
    const session = await starcite.session({
      identity: starcite.agent({ id: "coordinator" }),
      id: event.session_id,
      title: "Research Swarm",
    });

    session.on(
      "event",
      async (nextEvent, context) => {
        if (context.replayed) {
          return;
        }

        if (nextEvent.type === "message.user") {
          await runCoordinator(session, latestUserText(session.events()));
          return;
        }

        if (nextEvent.type !== "agent.done") {
          return;
        }

        const latestUserSeq = lastUserSeq(session.events());
        if (!latestUserSeq) {
          return;
        }

        const events = session.events();
        if (
          workerStartCount(events, latestUserSeq) === 0 ||
          workerDoneCount(events, latestUserSeq) <
            workerStartCount(events, latestUserSeq) ||
          hasSummaryMarker(events, latestUserSeq)
        ) {
          return;
        }

        await session.append({
          type: coordinatorSummaryStartedEventType,
          source: "agent",
          payload: { afterUserSeq: latestUserSeq },
        });

        await runCoordinator(
          session,
          "Summarize the completed specialist findings into one direct answer for the user. Do not ask follow-up questions."
        );

        await session.append({
          type: coordinatorSummaryDoneEventType,
          source: "agent",
          payload: { afterUserSeq: latestUserSeq },
        });
      },
      { replay: false }
    );
  })();
});

async function runCoordinator(
  session: StarciteSession,
  prompt: string
): Promise<void> {
  const result = streamText({
    model: coordinatorModel,
    system: [
      "You are a research coordinator.",
      "Use the full conversation and any specialist outputs already present in the session.",
      "Respond immediately and stream as you think.",
      "Use start_agent to launch 2-4 specialists only when specialist work would improve the answer.",
      "When enough specialist work is already complete, synthesize it directly instead of asking for more context.",
    ].join(" "),
    prompt: coordinatorPrompt(session.events(), prompt),
    tools: {
      start_agent: tool({
        description: "Start a specialist agent on this session.",
        inputSchema: startAgentInput,
        execute: async (assignment) => {
          await session.append({
            type: agentStartedEventType,
            source: "agent",
            payload: assignment,
          });

          void runWorker(session.id, assignment);
          return { ok: true };
        },
      }),
    },
  });

  for await (const delta of result.textStream) {
    await session.append({
      type: "agent.streaming.chunk",
      source: "agent",
      payload: {
        agent: "coordinator",
        name: "Coordinator",
        delta,
      },
    });
  }

  await session.append({
    type: "agent.done",
    source: "agent",
    payload: {
      agent: "coordinator",
      name: "Coordinator",
    },
  });
}

function coordinatorPrompt(
  events: readonly SessionEvent[],
  instruction: string
): string {
  const transcript = conversationTranscript(events);
  if (!transcript) {
    return instruction;
  }

  return [
    "Conversation so far:",
    transcript,
    "",
    "Current instruction:",
    instruction,
  ].join("\n");
}

async function runWorker(
  sessionId: string,
  assignment: z.infer<typeof startAgentInput>
): Promise<void> {
  const session = await starcite.session({
    identity: starcite.agent({ id: assignment.id }),
    id: sessionId,
  });

  const result = streamText({
    model: workerModel,
    system: `You are ${assignment.name}, a research specialist. Be concise, evidence-based, and useful.`,
    prompt: assignment.prompt,
  });

  for await (const delta of result.textStream) {
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
}

function conversationTranscript(events: readonly SessionEvent[]): string {
  const active = new Map<string, { name: string; text: string }>();
  const blocks: string[] = [];

  for (const event of events) {
    if (event.type === "message.user") {
      const text = stringField(objectPayload(event), "text");
      if (text?.trim()) {
        blocks.push(`User:\n${text.trim()}`);
      }
      continue;
    }

    if (event.type === "agent.streaming.chunk") {
      const payload = objectPayload(event);
      const agent = stringField(payload, "agent");
      if (!agent) {
        continue;
      }

      const current = active.get(agent) ?? {
        name: stringField(payload, "name") ?? agent,
        text: "",
      };
      current.text += stringField(payload, "delta") ?? "";
      active.set(agent, current);
      continue;
    }

    if (event.type === "agent.done") {
      const payload = objectPayload(event);
      const agent = stringField(payload, "agent");
      if (!agent) {
        continue;
      }

      const finished = active.get(agent);
      if (!finished?.text.trim()) {
        continue;
      }

      blocks.push(`${finished.name}:\n${finished.text.trim()}`);
      active.delete(agent);
    }
  }

  return blocks.join("\n\n");
}

function latestUserText(events: readonly SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "message.user") {
      return stringField(objectPayload(event), "text") ?? "";
    }
  }

  return "";
}

function lastUserSeq(events: readonly SessionEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "message.user") {
      return event.seq;
    }
  }

  return undefined;
}

function workerStartCount(events: readonly SessionEvent[], sinceSeq: number): number {
  let count = 0;

  for (const event of events) {
    if (event.seq <= sinceSeq || event.type !== agentStartedEventType) {
      continue;
    }

    if ((stringField(objectPayload(event), "id") ?? "") !== "coordinator") {
      count += 1;
    }
  }

  return count;
}

function workerDoneCount(events: readonly SessionEvent[], sinceSeq: number): number {
  let count = 0;

  for (const event of events) {
    if (event.seq <= sinceSeq || event.type !== "agent.done") {
      continue;
    }

    if ((stringField(objectPayload(event), "agent") ?? "") !== "coordinator") {
      count += 1;
    }
  }

  return count;
}

function hasSummaryMarker(events: readonly SessionEvent[], sinceSeq: number): boolean {
  return events.some(
    (event) =>
      event.seq > sinceSeq &&
      (event.type === coordinatorSummaryStartedEventType ||
        event.type === coordinatorSummaryDoneEventType)
  );
}

function objectPayload(event: SessionEvent): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function stringField(
  payload: Record<string, unknown>,
  key: string
): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}
