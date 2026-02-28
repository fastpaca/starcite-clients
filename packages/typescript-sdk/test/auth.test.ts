import { describe, expect, it } from "vitest";
import {
  formatAuthorizationHeader,
  inferCreatorPrincipalFromApiKey,
  inferIssuerAuthorityFromApiKey,
  tokenFromAuthorizationHeader,
} from "../src/auth";

function tokenFromClaims(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url"
  );
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.N6fK2qA`;
}

describe("formatAuthorizationHeader", () => {
  it("throws on empty string", () => {
    expect(() => formatAuthorizationHeader("")).toThrow("apiKey cannot be empty");
    expect(() => formatAuthorizationHeader("   ")).toThrow(
      "apiKey cannot be empty"
    );
  });

  it("prefixes a bare token with Bearer", () => {
    expect(formatAuthorizationHeader("my_token")).toBe("Bearer my_token");
  });

  it("passes through an already-prefixed bearer token", () => {
    expect(formatAuthorizationHeader("Bearer abc")).toBe("Bearer abc");
    expect(formatAuthorizationHeader("bearer abc")).toBe("bearer abc");
  });
});

describe("tokenFromAuthorizationHeader", () => {
  it("returns undefined for empty input", () => {
    expect(tokenFromAuthorizationHeader("")).toBeUndefined();
    expect(tokenFromAuthorizationHeader("   ")).toBeUndefined();
  });

  it("extracts a bearer token", () => {
    expect(tokenFromAuthorizationHeader("Bearer my_token")).toBe("my_token");
    expect(tokenFromAuthorizationHeader("bearer my_token")).toBe("my_token");
  });

  it("returns undefined when token contains spaces", () => {
    expect(tokenFromAuthorizationHeader("Bearer a b")).toBeUndefined();
  });

  it("returns undefined when token contains commas", () => {
    expect(tokenFromAuthorizationHeader("Bearer a,b")).toBeUndefined();
  });
});

describe("inferIssuerAuthorityFromApiKey", () => {
  it("extracts issuer authority from a valid JWT", () => {
    const token = tokenFromClaims({ iss: "https://starcite.ai/custom/path" });
    expect(inferIssuerAuthorityFromApiKey(token)).toBe("https://starcite.ai");
  });

  it("returns undefined for a non-JWT token", () => {
    expect(inferIssuerAuthorityFromApiKey("not_a_jwt")).toBeUndefined();
  });

  it("returns undefined for a non-http protocol", () => {
    const token = tokenFromClaims({ iss: "ftp://starcite.ai" });
    expect(inferIssuerAuthorityFromApiKey(token)).toBeUndefined();
  });

  it("strips path from issuer URL", () => {
    const token = tokenFromClaims({ iss: "https://auth.example.com/v1/keys" });
    expect(inferIssuerAuthorityFromApiKey(token)).toBe(
      "https://auth.example.com"
    );
  });
});

describe("inferCreatorPrincipalFromApiKey", () => {
  it("infers principal from org subject", () => {
    const token = tokenFromClaims({ sub: "org:acme" });
    const principal = inferCreatorPrincipalFromApiKey(token);
    expect(principal).toEqual({
      tenant_id: "acme",
      id: "org:acme",
      type: "user",
    });
  });

  it("returns undefined for agent subject (no tenant)", () => {
    const token = tokenFromClaims({ sub: "agent:planner" });
    expect(inferCreatorPrincipalFromApiKey(token)).toBeUndefined();
  });

  it("returns undefined for user subject (no tenant)", () => {
    const token = tokenFromClaims({ sub: "user:alice" });
    expect(inferCreatorPrincipalFromApiKey(token)).toBeUndefined();
  });

  it("uses explicit principal claims when present", () => {
    const token = tokenFromClaims({
      sub: "org:acme",
      principal: {
        principal_type: "agent",
        principal_id: "agent:planner",
      },
    });
    const principal = inferCreatorPrincipalFromApiKey(token);
    expect(principal).toEqual({
      tenant_id: "acme",
      id: "agent:planner",
      type: "agent",
    });
  });

  it("returns undefined when claims are missing", () => {
    const token = tokenFromClaims({});
    expect(inferCreatorPrincipalFromApiKey(token)).toBeUndefined();
  });
});
