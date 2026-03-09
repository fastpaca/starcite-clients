import OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses";
import type { SessionEvent, StarciteSession } from "@starcite/sdk";
import { EV, plStr, type AgentName } from "./contracts";

export interface OpenAIRuntimeOptions {
  apiKey: string;
  coordinatorModel?: string;
  model?: string;
  researcherModel?: string;
  writerModel?: string;
}

export interface TurnInput {
  session: StarciteSession;
  agent: AgentName;
  system: string;
  instruction: string;
  originSeq: number;
  stage: string;
}

export interface TurnResult {
  agent: AgentName;
  model: string;
  responseId: string;
  previousResponseId?: string;
  stage: string;
  text: string;
}

export class OpenAIRuntime {
  private readonly client: OpenAI;
  private readonly models: Record<AgentName, string>;

  constructor(opts: OpenAIRuntimeOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
    const def = opts.model ?? "gpt-4o-mini";
    this.models = {
      coordinator: opts.coordinatorModel ?? def,
      researcher: opts.researcherModel ?? def,
      writer: opts.writerModel ?? def,
    };
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const model = this.models[input.agent];
    const previousResponseId = latestResponseId(input.session.events(), input.agent);

    // Fire streaming call in parallel (best-effort chunks)
    const chunks = this.streamChunks(input, model, previousResponseId);

    const response = await this.client.responses.create({
      model,
      store: true,
      previous_response_id: previousResponseId,
      instructions: input.system,
      input: [{ role: "user", content: [{ type: "input_text", text: input.instruction }] }],
      metadata: { agent: input.agent, origin_seq: `${input.originSeq}`, stage: input.stage },
    });

    await chunks.catch(() => {});

    const result: TurnResult = {
      agent: input.agent, model, responseId: response.id,
      previousResponseId, stage: input.stage,
      text: extractText(response),
    };

    await input.session.append({
      type: EV.openAICompleted, source: "openai",
      payload: {
        agent: result.agent, model, originSeq: input.originSeq,
        previousResponseId, responseId: result.responseId,
        stage: result.stage, text: result.text,
      },
    });

    return result;
  }

  private async streamChunks(
    input: TurnInput, model: string, previousResponseId: string | undefined,
  ): Promise<void> {
    try {
      const stream = await this.client.responses.create({
        model, store: false, stream: true,
        previous_response_id: previousResponseId,
        instructions: input.system,
        input: [{ role: "user", content: [{ type: "input_text", text: input.instruction }] }],
      });

      let accumulated = "";
      let buffer = "";

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          const delta = (event as unknown as { delta: string }).delta;
          if (typeof delta !== "string") continue;
          accumulated += delta;
          buffer += delta;
          if (buffer.length >= 80) {
            input.session.append({
              type: EV.chunk, source: "agent",
              payload: { agent: input.agent, stage: input.stage, originSeq: input.originSeq, delta: buffer, accumulated },
            }).catch(() => {});
            buffer = "";
          }
        }
      }

      if (buffer) {
        await input.session.append({
          type: EV.chunk, source: "agent",
          payload: { agent: input.agent, stage: input.stage, originSeq: input.originSeq, delta: buffer, accumulated },
        }).catch(() => {});
      }
    } catch {
      // Best-effort
    }
  }
}

function latestResponseId(events: readonly SessionEvent[], agent: AgentName): string | undefined {
  const ev = [...events].reverse().find(
    (e) => e.type === EV.openAICompleted && plStr(e, "agent") === agent,
  );
  return ev ? plStr(ev, "responseId") : undefined;
}

function extractText(response: Response): string {
  const text = response.output_text.trim();
  if (text) return text;

  const chunks: string[] = [];
  for (const item of response.output) {
    if (item.type === "message") {
      for (const c of item.content) {
        if (c.type === "output_text") chunks.push(c.text);
      }
    }
  }

  const joined = chunks.join("\n").trim();
  if (joined) return joined;
  throw new Error(`OpenAI response ${response.id} returned no output text`);
}
