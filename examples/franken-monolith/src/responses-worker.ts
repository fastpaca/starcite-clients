import type { SessionEvent, StarciteSession } from "@starcite/sdk";
import { EV, plNum, plStr, textOf, type AgentName } from "./contracts";
import type { OpenAIRuntime, TurnInput } from "./openai-responses";

const SYSTEM: Record<string, string> = {
  "coordinator:plan": "You are the coordinator agent. Summarize the user goal and produce a short plan for the researcher and writer. Plain text, concise.",
  "coordinator:handoff": "You are the coordinator agent. Turn the research result into a concrete writing brief for the writer. Plain text only.",
  "coordinator:approval_request": "You are the coordinator agent. Write a concise approval request for the user about the current draft. Plain text only.",
  "researcher:research": "You are the research agent. Identify constraints, assumptions, risks, and missing context. Plain text, concise.",
  "writer:draft": "You are the writer agent. Produce an internal draft response for review before user approval. Plain text, concise.",
  "writer:finalize": "You are the writer agent. Produce the final user-facing answer after approval. Plain text, ready to send.",
};

function sys(agent: AgentName, stage: string): string {
  return SYSTEM[`${agent}:${stage}`] ?? `You are the ${agent} agent.`;
}

export interface WorkerSessions {
  /** The session used for subscribing to events (any identity works, all see the same events) */
  stream: StarciteSession;
  /** Per-agent sessions for appending events with the correct actor */
  agents: Record<AgentName, StarciteSession>;
}

export class ResponsesWorker {
  constructor(private readonly openai: OpenAIRuntime) {}

  /** Subscribe to session events and drive the workflow. Returns unsubscribe function. */
  start(sessions: WorkerSessions): () => void {
    return sessions.stream.on("event", (event) => {
      void this.dispatch(sessions, event).catch((err) => {
        console.error(`[worker] ${event.type}:`, err instanceof Error ? err.message : err);
      });
    }, { replay: true });
  }

  private async dispatch(s: WorkerSessions, event: SessionEvent): Promise<void> {
    switch (event.type) {
      case EV.userMessage: return this.onUserMessage(s, event);
      case EV.taskAssigned: return this.onTaskAssigned(s, event);
      case EV.reportPublished: return this.onReport(s, event);
      case EV.draftReady: return this.onDraft(s, event);
      case EV.approvalReceived: return this.onApproval(s, event);
    }
  }

  private async onUserMessage(s: WorkerSessions, event: SessionEvent): Promise<void> {
    if (hasForOrigin(s.stream, EV.workflowStarted, event.seq)) return;
    const userText = textOf(event);
    if (!userText) return;

    const turn = await this.run(s, {
      agent: "coordinator", stage: "plan", originSeq: event.seq,
      instruction: `Create a short multi-agent plan for this user request.\nUser request: ${userText}`,
    });

    await s.agents.coordinator.append({
      type: EV.workflowStarted, source: "agent",
      payload: { originSeq: event.seq, text: turn.text },
    });
    await s.agents.coordinator.append({
      type: EV.taskAssigned, source: "agent",
      payload: {
        instruction: `User request: ${userText}\nCoordinator plan: ${turn.text}`,
        originSeq: event.seq, stage: "research", target: "researcher",
      },
    });
  }

  private async onTaskAssigned(s: WorkerSessions, event: SessionEvent): Promise<void> {
    const target = plStr(event, "target") as AgentName | undefined;
    const stage = plStr(event, "stage");
    const instruction = plStr(event, "instruction");
    if (!(target && stage && instruction)) return;

    if (target === "researcher") {
      if (hasForOrigin(s.stream, EV.reportPublished, event.seq)) return;
      const turn = await this.run(s, { agent: "researcher", stage, originSeq: event.seq, instruction });
      await s.agents.researcher.append({
        type: EV.reportPublished, source: "agent",
        payload: { originSeq: event.seq, text: turn.text },
      });
      return;
    }

    if (target === "writer") {
      if (stage === "draft") {
        if (hasForOrigin(s.stream, EV.draftReady, event.seq)) return;
        const turn = await this.run(s, { agent: "writer", stage, originSeq: event.seq, instruction });
        await s.agents.writer.append({
          type: EV.draftReady, source: "agent",
          payload: { originSeq: event.seq, text: turn.text },
        });
      } else if (stage === "finalize") {
        if (hasForOrigin(s.stream, EV.finalAnswer, event.seq)) return;
        const turn = await this.run(s, { agent: "writer", stage, originSeq: event.seq, instruction });
        await s.agents.writer.append({
          type: EV.finalAnswer, source: "agent",
          payload: { originSeq: event.seq, text: turn.text },
        });
      }
    }
  }

  private async onReport(s: WorkerSessions, event: SessionEvent): Promise<void> {
    if (hasTask(s.stream, { originSeq: event.seq, stage: "draft", target: "writer" })) return;
    const researchText = textOf(event);
    const userText = latestText(s.stream, EV.userMessage);
    const workflowText = latestText(s.stream, EV.workflowStarted);
    if (!(researchText && userText && workflowText)) return;

    const turn = await this.run(s, {
      agent: "coordinator", stage: "handoff", originSeq: event.seq,
      instruction: [
        `User request: ${userText}`,
        `Coordinator plan: ${workflowText}`,
        `Research summary: ${researchText}`,
        "Convert this into a concrete writing brief for the writer agent.",
      ].join("\n"),
    });

    await s.agents.coordinator.append({
      type: EV.taskAssigned, source: "agent",
      payload: { instruction: turn.text, originSeq: event.seq, stage: "draft", target: "writer" },
    });
  }

  private async onDraft(s: WorkerSessions, event: SessionEvent): Promise<void> {
    if (hasForOrigin(s.stream, EV.approvalRequested, event.seq)) return;
    const draftText = textOf(event);
    const userText = latestText(s.stream, EV.userMessage);
    if (!(draftText && userText)) return;

    const turn = await this.run(s, {
      agent: "coordinator", stage: "approval_request", originSeq: event.seq,
      instruction: [
        `Original user request: ${userText}`,
        `Draft for approval: ${draftText}`,
        "Write a concise approval request for the user.",
      ].join("\n"),
    });

    await s.agents.coordinator.append({
      type: EV.approvalRequested, source: "agent",
      payload: { originSeq: event.seq, text: turn.text },
    });
  }

  private async onApproval(s: WorkerSessions, event: SessionEvent): Promise<void> {
    if (hasTask(s.stream, { originSeq: event.seq, stage: "finalize", target: "writer" })) return;
    const approvalText = textOf(event);
    const userText = latestText(s.stream, EV.userMessage);
    const researchText = latestText(s.stream, EV.reportPublished);
    const draftText = latestText(s.stream, EV.draftReady);
    if (!(userText && researchText && draftText && approvalText)) return;

    await s.agents.coordinator.append({
      type: EV.taskAssigned, source: "agent",
      payload: {
        instruction: [
          `Original user request: ${userText}`,
          `Research summary: ${researchText}`,
          `Approved draft: ${draftText}`,
          `User approval note: ${approvalText}`,
          "Produce the final user-facing answer.",
        ].join("\n"),
        originSeq: event.seq, stage: "finalize", target: "writer",
      },
    });
  }

  private run(s: WorkerSessions, opts: Omit<TurnInput, "session" | "system">) {
    return this.openai.runTurn({
      ...opts,
      session: s.agents[opts.agent],
      system: sys(opts.agent, opts.stage),
    });
  }
}

// --- Helpers ---

function latestText(session: StarciteSession, type: string): string | undefined {
  const ev = [...session.events()].reverse().find((e) => e.type === type);
  return ev ? textOf(ev) : undefined;
}

function hasForOrigin(session: StarciteSession, type: string, originSeq: number): boolean {
  return session.events().some((e) => e.type === type && plNum(e, "originSeq") === originSeq);
}

function hasTask(session: StarciteSession, input: { originSeq: number; stage: string; target: string }): boolean {
  return session.events().some(
    (e) => e.type === EV.taskAssigned &&
      plNum(e, "originSeq") === input.originSeq &&
      plStr(e, "stage") === input.stage &&
      plStr(e, "target") === input.target,
  );
}
