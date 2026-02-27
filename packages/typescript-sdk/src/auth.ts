import { StarciteError } from "./errors";
import type { SessionCreatorPrincipal } from "./types";
import { SessionCreatorPrincipalSchema } from "./types";

const BEARER_PREFIX_REGEX = /^bearer\s+/i;
const TRAILING_SLASHES_REGEX = /\/+$/;
const SERVICE_TOKEN_SUB_ORG_PREFIX = "org:";
const SERVICE_TOKEN_SUB_AGENT_PREFIX = "agent:";
const SERVICE_TOKEN_SUB_USER_PREFIX = "user:";

function firstNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseJwtSegment(segment: string): string | undefined {
  const base64 = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(segment.length + ((4 - (segment.length % 4)) % 4), "=");

  try {
    if (typeof atob === "function") {
      return atob(base64);
    }

    if (typeof Buffer !== "undefined") {
      return Buffer.from(base64, "base64").toString("utf8");
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseJwtClaims(apiKey: string): Record<string, unknown> | undefined {
  const token = apiKey.replace(BEARER_PREFIX_REGEX, "").trim();
  const parts = token.split(".");

  if (parts.length !== 3) {
    return undefined;
  }

  const payload = parseJwtSegment(parts[1] ?? "");

  if (!payload) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(payload) as unknown;
    return decoded !== null && typeof decoded === "object"
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseClaimStrings(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = firstNonEmptyString(source[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function parseActorIdentityFromSubject(
  subject: string
): { id: string; type: "agent" | "user" } | undefined {
  if (subject.startsWith(SERVICE_TOKEN_SUB_AGENT_PREFIX)) {
    return { id: subject, type: "agent" };
  }

  if (subject.startsWith(SERVICE_TOKEN_SUB_USER_PREFIX)) {
    return { id: subject, type: "user" };
  }

  return undefined;
}

function parseTenantIdFromSubject(subject: string): string {
  if (parseActorIdentityFromSubject(subject) !== undefined) {
    return "";
  }

  if (subject.startsWith(SERVICE_TOKEN_SUB_ORG_PREFIX)) {
    return subject.slice(SERVICE_TOKEN_SUB_ORG_PREFIX.length).trim();
  }

  return subject;
}

function parseCreatorPrincipalFromClaims(
  claims: Record<string, unknown>
): SessionCreatorPrincipal | undefined {
  const subject = firstNonEmptyString(claims.sub);
  const explicitPrincipal =
    claims.principal && typeof claims.principal === "object"
      ? (claims.principal as Record<string, unknown>)
      : undefined;
  const mergedClaims = explicitPrincipal
    ? { ...claims, ...explicitPrincipal }
    : claims;
  const actorFromSubject = subject
    ? parseActorIdentityFromSubject(subject)
    : undefined;
  const principalTypeFromClaims = parseClaimStrings(mergedClaims, [
    "principal_type",
    "principalType",
    "type",
  ]);
  const tenantId = parseClaimStrings(mergedClaims, ["tenant_id", "tenantId"]);
  const rawPrincipalId = parseClaimStrings(mergedClaims, [
    "principal_id",
    "principalId",
    "id",
    "sub",
  ]);
  const actorFromRawId = rawPrincipalId
    ? parseActorIdentityFromSubject(rawPrincipalId)
    : undefined;

  const principal = {
    tenant_id: tenantId ?? (subject ? parseTenantIdFromSubject(subject) : ""),
    id: rawPrincipalId ?? actorFromSubject?.id ?? "",
    type:
      principalTypeFromClaims === "agent" || principalTypeFromClaims === "user"
        ? principalTypeFromClaims
        : (actorFromSubject?.type ?? actorFromRawId?.type ?? "user"),
  };

  if (
    principal.tenant_id.length === 0 ||
    principal.id.length === 0 ||
    principal.type.length === 0
  ) {
    return undefined;
  }

  const result = SessionCreatorPrincipalSchema.safeParse(principal);
  return result.success ? result.data : undefined;
}

export function formatAuthorizationHeader(apiKey: string): string {
  const token = apiKey.trim();

  if (token.length === 0) {
    throw new StarciteError("apiKey cannot be empty");
  }

  if (BEARER_PREFIX_REGEX.test(token)) {
    return token;
  }

  return `Bearer ${token}`;
}

/**
 * Extracts the raw JWT token from an authorization header value.
 */
export function tokenFromAuthorizationHeader(
  authorization: string
): string | undefined {
  const normalized = authorization.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  const token = normalized.replace(BEARER_PREFIX_REGEX, "").trim();

  if (token.length === 0) {
    return undefined;
  }

  if (token.includes(",") || token.includes(" ")) {
    return undefined;
  }

  return token;
}

/**
 * Extracts the issuer authority (protocol + host) from an API key JWT.
 *
 * Example:
 * - `iss=https://starcite.ai` -> `https://starcite.ai`
 * - `iss=https://starcite.ai/custom/path` -> `https://starcite.ai`
 */
export function inferIssuerAuthorityFromApiKey(
  apiKey: string
): string | undefined {
  const claims = parseJwtClaims(apiKey);
  const issuer = claims ? firstNonEmptyString(claims.iss) : undefined;

  if (!issuer) {
    return undefined;
  }

  try {
    const parsed = new URL(issuer);
    if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
      return undefined;
    }
    return parsed.origin.replace(TRAILING_SLASHES_REGEX, "");
  } catch {
    return undefined;
  }
}

export function inferCreatorPrincipalFromApiKey(
  apiKey: string
): SessionCreatorPrincipal | undefined {
  const claims = parseJwtClaims(apiKey);
  return claims ? parseCreatorPrincipalFromClaims(claims) : undefined;
}
