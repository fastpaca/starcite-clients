/**
 * Stable error text extraction for transport and parsing failures.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown error";
}

/**
 * Converts actor values like `agent:planner` to agent names.
 */
export function agentFromActor(actor: string): string | undefined {
  if (actor.startsWith("agent:")) {
    return actor.slice("agent:".length);
  }

  return undefined;
}

/**
 * Converts an agent name to actor format (`agent:<name>`).
 */
export function toAgentActor(agent: string): string {
  const normalized = agent.trim();
  return normalized.startsWith("agent:") ? normalized : `agent:${normalized}`;
}
