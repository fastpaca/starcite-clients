import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool } from "ai";
import { Starcite } from "@starcite/sdk";
import { z } from "zod";

/** Single server client: session route and `session.created` must share this instance. */
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

starcite.on("session.created", (event) => {
  void (async () => {
    const sessionId = event.session_id;
    const session = await starcite.session({
      identity: starcite.agent({ id: "coordinator" }),
      id: sessionId,
      title: "Research Swarm",
    });

    session.on(
      "event",
      async (ev, context) => {
        if (context.replayed || ev.type !== "message.user") {
          return;
        }

        const question = String(ev.payload["text"] ?? "").trim();
        if (!question) {
          return;
        }

        const result = streamText({
          model: coordinatorModel,
          system: [
            "You are a research coordinator.",
            "Respond to the user and launch 2–4 specialists with start_agent when useful.",
          ].join(" "),
          prompt: question,
          tools: {
            start_agent: tool({
              description: "Start a specialist agent on this session.",
              inputSchema: startAgentInput,
              execute: async ({ id, name, prompt }) => {
                void subagent(sessionId, { id, name, prompt });
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
          payload: { agent: "coordinator", name: "Coordinator" },
        });
      },
      { replay: false }
    );
  })();
});

async function subagent(
  sessionId: string,
  assignment: { id: string; name: string; prompt: string }
): Promise<void> {
  // We need our own session attached identity (distinct from the coordinator).
  const session = await starcite.session({
    identity: starcite.agent({ id: assignment.id }),
    id: sessionId,
  });

  const result = streamText({
    model: workerModel,
    system: `You are ${assignment.name}, a research specialist. Evidence-based, concise, markdown.`,
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
    payload: { agent: assignment.id, name: assignment.name },
  });
}
