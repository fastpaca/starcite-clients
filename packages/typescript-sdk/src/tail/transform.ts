import type { SessionEvent, TailEvent } from "../types";

export function agentFromActor(actor: string): string | undefined {
  if (actor.startsWith("agent:")) {
    return actor.slice("agent:".length);
  }

  return undefined;
}

export function toSessionEvent(event: TailEvent): SessionEvent {
  const agent = agentFromActor(event.actor);
  const text =
    typeof event.payload.text === "string" ? event.payload.text : undefined;

  return {
    ...event,
    agent,
    text,
  };
}
