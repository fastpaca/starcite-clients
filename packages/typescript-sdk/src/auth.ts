import { decodeJwt } from "jose";
import { z } from "zod";
import type { PrincipalType } from "./identity";
import { PrincipalTypeSchema, StarciteIdentity } from "./identity";

const ApiKeyPrincipalTypeSchema = z.enum(["user", "agent", "service"]);
type ApiKeyPrincipalType = z.infer<typeof ApiKeyPrincipalTypeSchema>;

const ApiKeyClaimsSchema = z.object({
  iss: z.string().min(1).optional(),
  sub: z.string().min(1).optional(),
  tenant_id: z.string().min(1).optional(),
  principal_id: z.string().min(1).optional(),
  principal_type: ApiKeyPrincipalTypeSchema.optional(),
});

const SessionTokenClaimsSchema = z.object({
  session_id: z.string().min(1).optional(),
  sub: z.string().min(1).optional(),
  tenant_id: z.string().min(1),
  principal_id: z.string().min(1).optional(),
  principal_type: PrincipalTypeSchema.optional(),
});

interface ApiKeyContext {
  issuerAuthority?: string;
  tenantId?: string;
  identity?: StarciteIdentity;
}

function resolvePrincipal(
  rawId: string,
  defaultType: PrincipalType
): { id: string; type: PrincipalType } {
  if (rawId.startsWith("agent:")) {
    return {
      id: rawId.slice("agent:".length),
      type: "agent",
    };
  }

  if (rawId.startsWith("user:")) {
    return {
      id: rawId.slice("user:".length),
      type: "user",
    };
  }

  return { id: rawId, type: defaultType };
}

function resolveApiKeyIdentity(
  tenantId: string | undefined,
  rawId: string | undefined,
  principalType: ApiKeyPrincipalType
): StarciteIdentity | undefined {
  if (!(tenantId && rawId)) {
    return undefined;
  }

  if (principalType === "service") {
    return undefined;
  }

  const principal = resolvePrincipal(rawId, principalType);

  return new StarciteIdentity({
    tenantId,
    id: principal.id,
    type: principal.type,
  });
}

/**
 * Decodes API key claims into the tenant-scoped context the SDK needs.
 */
export function decodeApiKeyContext(apiKey: string): ApiKeyContext {
  const claims = ApiKeyClaimsSchema.parse(decodeJwt(apiKey));
  const issuerAuthority = claims.iss ? new URL(claims.iss).origin : undefined;
  const principalType = claims.principal_type ?? "user";

  return {
    issuerAuthority,
    tenantId: claims.tenant_id,
    identity: resolveApiKeyIdentity(
      claims.tenant_id,
      claims.principal_id ?? claims.sub,
      principalType,
    ),
  };
}

/**
 * Decodes session token JWT claims and returns the session ID and identity.
 */
export function decodeSessionToken(token: string): {
  sessionId?: string;
  identity: StarciteIdentity;
} {
  const claims = SessionTokenClaimsSchema.parse(decodeJwt(token));
  const rawId = claims.principal_id ?? claims.sub ?? "session-user";
  const principal = resolvePrincipal(rawId, claims.principal_type ?? "user");

  return {
    sessionId: claims.session_id,
    identity: new StarciteIdentity({
      tenantId: claims.tenant_id,
      id: principal.id,
      type: principal.type,
    }),
  };
}
