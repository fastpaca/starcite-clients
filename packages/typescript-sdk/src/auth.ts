import { decodeJwt } from "jose";
import { z } from "zod";
import { StarciteError } from "./errors";
import { PrincipalTypeSchema, StarciteIdentity } from "./identity";

const BEARER_RE = /^bearer\s+/i;

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
  principal_id: z.string().min(1),
  principal_type: PrincipalTypeSchema,
});

function stripBearer(value: string): string {
  return value.replace(BEARER_RE, "").trim();
}

/**
 * Converts an API key or bearer token value to `Authorization` header format.
 */
export function formatAuthorizationHeader(apiKey: string): string {
  const token = apiKey.trim();
  if (token.length === 0) throw new StarciteError("apiKey cannot be empty");
  return BEARER_RE.test(token) ? token : `Bearer ${token}`;
}

/**
 * Extracts the raw JWT token from an authorization header value.
 */
export function tokenFromAuthorizationHeader(
  authorization: string,
): string {
  const token = stripBearer(authorization);
  if (token.length === 0) {
    throw new StarciteError("Authorization header contains no token");
  }
  return token;
}

/**
 * Extracts the issuer authority (protocol + host) from an API key JWT.
 */
export function inferIssuerAuthorityFromApiKey(
  apiKey: string,
): string | undefined {
  const claims = ApiKeyClaimsSchema.parse(decodeJwt(stripBearer(apiKey)));
  if (!claims.iss) return undefined;
  const url = new URL(claims.iss);
  return url.origin;
}

/**
 * Infers caller identity from API key JWT claims.
 */
export function inferIdentityFromApiKey(
  apiKey: string,
): StarciteIdentity | undefined {
  const claims = ApiKeyClaimsSchema.parse(decodeJwt(stripBearer(apiKey)));

  const id = claims.principal_id ?? claims.sub;
  const tenantId = claims.tenant_id;

  if (!tenantId || !id || !claims.principal_type) return undefined;

  return new StarciteIdentity({
    tenantId,
    id,
    type: claims.principal_type,
  });
}

/**
 * Decodes session token JWT claims and returns the session ID and identity.
 */
export function decodeSessionToken(
  token: string,
): { sessionId?: string; identity: StarciteIdentity } {
  const raw = decodeJwt(stripBearer(token));
  const claims = SessionTokenClaimsSchema.parse(raw);

  return {
    sessionId: claims.session_id,
    identity: new StarciteIdentity({
      tenantId: claims.tenant_id,
      id: claims.principal_id,
      type: claims.principal_type,
    }),
  };
}
