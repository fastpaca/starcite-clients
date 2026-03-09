import OpenAI from "openai";
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

    const stream = await this.client.responses.create({
      model,
      stream: true,
      store: true,
      previous_response_id: previousResponseId,
      instructions: input.system,
      input: [{ role: "user", content: [{ type: "input_text", text: input.instruction }] }],
      metadata: { agent: input.agent, origin_seq: `${input.originSeq}`, stage: input.stage },
    });

    let accumulated = "";
    let buffer = "";
    let responseId: string | undefined;

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        accumulated += event.delta;
        buffer += event.delta;
        if (buffer.length >= 80) {
          input.session.append({
            type: EV.chunk, source: "agent",
            payload: { agent: input.agent, stage: input.stage, originSeq: input.originSeq, delta: buffer, accumulated },
          }).catch(() => {});
          buffer = "";
        }
      } else if (event.type === "response.completed") {
        responseId = event.response.id;
      }
    }

    if (buffer) {
      await input.session.append({
        type: EV.chunk, source: "agent",
        payload: { agent: input.agent, stage: input.stage, originSeq: input.originSeq, delta: buffer, accumulated },
      }).catch(() => {});
    }

    const text = accumulated.trim();
    if (!text) throw new Error(`Empty response from ${input.agent}`);

    const result: TurnResult = {
      agent: input.agent, model,
      responseId: responseId ?? "unknown",
      previousResponseId, stage: input.stage, text,
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
}

function latestResponseId(events: readonly SessionEvent[], agent: AgentName): string | undefined {
  const ev = [...events].reverse().find(
    (e) => e.type === EV.openAICompleted && plStr(e, "agent") === agent,
  );
  return ev ? plStr(ev, "responseId") : undefined;
}
