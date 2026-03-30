import { describe, expect, it } from "vitest";
import { decodeApiKeyContext } from "../src/auth";

function tokenFromClaims(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url"
  );
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.N6fK2qA`;
}

describe("decodeApiKeyContext — issuerAuthority", () => {
  it("extracts issuer authority from a valid JWT", () => {
    const token = tokenFromClaims({ iss: "https://starcite.ai/custom/path" });
    expect(decodeApiKeyContext(token).issuerAuthority).toBe(
      "https://starcite.ai"
    );
  });

  it("throws for a non-JWT token", () => {
    expect(() => decodeApiKeyContext("not_a_jwt")).toThrow();
  });

  it("strips path from issuer URL", () => {
    const token = tokenFromClaims({ iss: "https://auth.example.com/v1/keys" });
    expect(decodeApiKeyContext(token).issuerAuthority).toBe(
      "https://auth.example.com"
    );
  });

  it("returns undefined when iss is missing", () => {
    const token = tokenFromClaims({});
    expect(decodeApiKeyContext(token).issuerAuthority).toBeUndefined();
  });
});

describe("decodeApiKeyContext — tenantId", () => {
  it("extracts tenant_id from claims", () => {
    const token = tokenFromClaims({ tenant_id: "acme" });
    expect(decodeApiKeyContext(token).tenantId).toBe("acme");
  });

  it("returns undefined when tenant_id is missing", () => {
    const token = tokenFromClaims({});
    expect(decodeApiKeyContext(token).tenantId).toBeUndefined();
  });
});
