import type { SessionEvent } from "@starcite/sdk";

export const agentNames = ["coordinator", "researcher", "writer"] as const;
export type AgentName = (typeof agentNames)[number];

// Event types
export const EV = {
  userMessage: "message.user",
  workflowStarted: "workflow.started",
  taskAssigned: "agent.task.assigned",
  reportPublished: "agent.report.published",
  draftReady: "draft.ready",
  approvalRequested: "user.approval.requested",
  approvalReceived: "user.approval.received",
  finalAnswer: "final.answer",
  openAICompleted: "openai.response.completed",
  chunk: "agent.streaming.chunk",
} as const;

// Payload helpers

export function pl(event: SessionEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

export function plStr(event: SessionEvent, key: string): string | undefined {
  const v = pl(event)[key];
  return typeof v === "string" ? v : undefined;
}

export function plNum(event: SessionEvent, key: string): number | undefined {
  const v = pl(event)[key];
  return typeof v === "number" ? v : undefined;
}

export function textOf(event: SessionEvent): string | undefined {
  if (typeof event.payload === "string") return event.payload;
  return plStr(event, "text");
}
