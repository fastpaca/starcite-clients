import { decodeJwt } from "jose";
import { z } from "zod";
import type { PrincipalType } from "./identity";
import { PrincipalTypeSchema, StarciteIdentity } from "./identity";

const ACTOR_PREFIX_RE = /^(agent|user):(.+)$/;

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
  const type = claims.principal_type ?? "user";

  if (!(tenantId && id)) {
    return undefined;
  }

  return new StarciteIdentity({
    tenantId,
    id,
    type,
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
  const rawId = claims.principal_id ?? claims.sub ?? "session-user";
  const defaultType = claims.principal_type ?? "user";

  // The server may encode principal_id as the full actor string (e.g. "user:alice").
  // Strip the prefix and infer the type when present.
  const prefixMatch = ACTOR_PREFIX_RE.exec(rawId);
  const principalId = prefixMatch?.[2] ?? rawId;
  const principalType: PrincipalType = prefixMatch
    ? (prefixMatch[1] as PrincipalType)
    : defaultType;

  return {
    sessionId: claims.session_id,
    identity: new StarciteIdentity({
      tenantId: claims.tenant_id,
      id: principalId,
      type: principalType,
    }),
  };
}
