import { decodeJwt } from "jose";
import { z } from "zod";
import { PrincipalTypeSchema, StarciteIdentity } from "./identity";

const ApiKeyClaimsSchema = z.object({
  iss: z.string().min(1).optional(),
  sub: z.string().min(1).optional(),
  tenant_id: z.string().min(1).optional(),
  principal_id: z.string().min(1).optional(),
  principal_type: PrincipalTypeSchema.optional(),
});

const SessionTokenClaimsSchema = z.object({
  session_id: z.string().min(1).optional(),
  sub: z.string().min(1).optional(),
  tenant_id: z.string().min(1),
  principal_id: z.string().min(1).optional(),
  principal_type: PrincipalTypeSchema.optional(),
});

/**
 * Extracts the issuer authority (protocol + host) from an API key JWT.
 */
export function inferIssuerAuthorityFromApiKey(
  apiKey: string
): string | undefined {
  const claims = ApiKeyClaimsSchema.parse(decodeJwt(apiKey));
  if (!claims.iss) {
    return undefined;
  }
  const url = new URL(claims.iss);
  return url.origin;
}

/**
 * Infers caller identity from API key JWT claims.
 */
export function inferIdentityFromApiKey(
  apiKey: string
): StarciteIdentity | undefined {
  const claims = ApiKeyClaimsSchema.parse(decodeJwt(apiKey));

  const id = claims.principal_id ?? claims.sub;
  const tenantId = claims.tenant_id;

  if (!(tenantId && id && claims.principal_type)) {
    return undefined;
  }

  return new StarciteIdentity({
    tenantId,
    id,
    type: claims.principal_type,
  });
}

/**
 * Decodes session token JWT claims and returns the session ID and identity.
 */
export function decodeSessionToken(token: string): {
  sessionId?: string;
  identity: StarciteIdentity;
} {
  const claims = SessionTokenClaimsSchema.parse(decodeJwt(token));
  const principalId = claims.principal_id ?? claims.sub ?? "session-user";
  const principalType = claims.principal_type ?? "user";

  return {
    sessionId: claims.session_id,
    identity: new StarciteIdentity({
      tenantId: claims.tenant_id,
      id: principalId,
      type: principalType,
    }),
  };
}
