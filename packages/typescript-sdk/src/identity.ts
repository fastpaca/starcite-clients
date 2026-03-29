import { z } from "zod";

const AGENT_PREFIX = "agent:";
const USER_PREFIX = "user:";

export const PrincipalTypeSchema = z.enum(["user", "agent"]);
export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;

export interface SessionCreatorPrincipal {
  tenant_id: string;
  id: string;
  type: PrincipalType;
}

export interface SessionTokenPrincipal {
  type: PrincipalType;
  id: string;
}

function hasPrincipalPrefix(id: string): boolean {
  return id.startsWith(AGENT_PREFIX) || id.startsWith(USER_PREFIX);
}

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
    if (hasPrincipalPrefix(options.id)) {
      throw new Error(
        `StarciteIdentity id must not include a principal prefix; received '${options.id}'`
      );
    }

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
    return `${this.type}:${this.id}`;
  }
}
