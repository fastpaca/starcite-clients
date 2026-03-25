import { describe, expect, it } from "vitest";
import {
  decodeApiKeyContext,
  inferIdentityFromApiKey,
  inferIssuerAuthorityFromApiKey,
} from "../src/auth";

function tokenFromClaims(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url"
  );
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.N6fK2qA`;
}

describe("inferIssuerAuthorityFromApiKey", () => {
  it("extracts issuer authority from a valid JWT", () => {
    const token = tokenFromClaims({ iss: "https://starcite.ai/custom/path" });
    expect(inferIssuerAuthorityFromApiKey(token)).toBe("https://starcite.ai");
  });

  it("throws for a non-JWT token", () => {
    expect(() => inferIssuerAuthorityFromApiKey("not_a_jwt")).toThrow();
  });

  it("strips path from issuer URL", () => {
    const token = tokenFromClaims({ iss: "https://auth.example.com/v1/keys" });
    expect(inferIssuerAuthorityFromApiKey(token)).toBe(
      "https://auth.example.com"
    );
  });

  it("returns undefined when iss is missing", () => {
    const token = tokenFromClaims({});
    expect(inferIssuerAuthorityFromApiKey(token)).toBeUndefined();
  });
});

describe("inferIdentityFromApiKey", () => {
  it("infers identity from explicit claims", () => {
    const token = tokenFromClaims({
      tenant_id: "acme",
      principal_id: "planner",
      principal_type: "agent",
    });
    const identity = inferIdentityFromApiKey(token);
    expect(identity).toBeDefined();
    expect(identity).toEqual(
      expect.objectContaining({
        tenantId: "acme",
        id: "planner",
        type: "agent",
      })
    );
  });

  it("falls back to sub for id when principal_id is absent", () => {
    const token = tokenFromClaims({
      sub: "planner",
      tenant_id: "acme",
      principal_type: "agent",
    });
    const identity = inferIdentityFromApiKey(token);
    expect(identity).toBeDefined();
    expect(identity).toEqual(
      expect.objectContaining({
        tenantId: "acme",
        id: "planner",
        type: "agent",
      })
    );
  });

  it("returns undefined when tenant_id is missing", () => {
    const token = tokenFromClaims({
      principal_id: "planner",
      principal_type: "agent",
    });
    expect(inferIdentityFromApiKey(token)).toBeUndefined();
  });

  it("normalizes actor-style principal_id claims", () => {
    const token = tokenFromClaims({
      tenant_id: "acme",
      principal_id: "agent:planner",
      principal_type: "user",
    });

    expect(inferIdentityFromApiKey(token)).toEqual(
      expect.objectContaining({
        tenantId: "acme",
        id: "planner",
        type: "agent",
      })
    );
  });

  it("defaults principal_type to user when missing", () => {
    const token = tokenFromClaims({
      tenant_id: "acme",
      principal_id: "planner",
    });
    const identity = inferIdentityFromApiKey(token);
    expect(identity).toBeDefined();
    expect(identity).toEqual(
      expect.objectContaining({
        tenantId: "acme",
        id: "planner",
        type: "user",
      })
    );
  });

  it("returns undefined when claims are empty", () => {
    const token = tokenFromClaims({});
    expect(inferIdentityFromApiKey(token)).toBeUndefined();
  });

  it("returns undefined for service principals", () => {
    const token = tokenFromClaims({
      tenant_id: "acme",
      principal_id: "svc-backend",
      principal_type: "service",
    });

    expect(inferIdentityFromApiKey(token)).toBeUndefined();
  });
});

describe("decodeApiKeyContext", () => {
  it("keeps tenant scope for service principals without inventing an identity", () => {
    const token = tokenFromClaims({
      tenant_id: "acme",
      principal_id: "svc-backend",
      principal_type: "service",
    });

    expect(decodeApiKeyContext(token)).toEqual({
      issuerAuthority: undefined,
      tenantId: "acme",
      identity: undefined,
    });
  });
});
