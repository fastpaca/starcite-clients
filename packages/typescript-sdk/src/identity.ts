import { z } from "zod";

const AGENT_PREFIX = "agent:";
const USER_PREFIX = "user:";

export const PrincipalTypeSchema = z.enum(["user", "agent"]);
export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;

export const SessionCreatorPrincipalSchema = z.object({
  tenant_id: z.string().min(1),
  id: z.string().min(1),
  type: PrincipalTypeSchema,
});

export type SessionCreatorPrincipal = z.infer<
  typeof SessionCreatorPrincipalSchema
>;

export const SessionTokenPrincipalSchema = z.object({
  type: PrincipalTypeSchema,
  id: z.string().min(1),
});

export type SessionTokenPrincipal = z.infer<typeof SessionTokenPrincipalSchema>;

/**
 * Represents a resolved caller identity with tenant, principal id, and type.
 */
export class StarciteIdentity {
  readonly tenantId: string;
  readonly id: string;
  readonly type: PrincipalType;

  constructor(options: {
    tenantId: string;
    id: string;
    type: PrincipalType;
  }) {
    this.tenantId = options.tenantId;
    this.id = options.id;
    this.type = options.type;
  }

  /**
   * Serializes to the `creator_principal` wire format expected by the API.
   */
  toCreatorPrincipal(): SessionCreatorPrincipal {
    return { tenant_id: this.tenantId, id: this.id, type: this.type };
  }

  /**
   * Serializes to the `principal` wire format used in session token requests.
   */
  toTokenPrincipal(): SessionTokenPrincipal {
    return { id: this.id, type: this.type };
  }

  /**
   * Returns the actor string derived from this identity (e.g. `agent:planner`, `user:alice`).
   */
  toActor(): string {
    if (this.id.startsWith(AGENT_PREFIX) || this.id.startsWith(USER_PREFIX)) {
      return this.id;
    }
    return `${this.type}:${this.id}`;
  }
}

/**
 * Extracts the agent name from an actor value like `agent:planner`.
 */
export function agentFromActor(actor: string): string | undefined {
  return actor.startsWith(AGENT_PREFIX)
    ? actor.slice(AGENT_PREFIX.length)
    : undefined;
}
