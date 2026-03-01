import { describe, expect, it } from "vitest";
import { Starcite } from "../src/client";
import { StarciteIdentity } from "../src/identity";

const LIVE_API_BASE_URL =
  process.env.STARCITE_LIVE_API_BASE_URL ?? "https://api.starcite.io";
const LIVE_API_KEY = process.env.STARCITE_LIVE_API_KEY;
const SESSION_ID_PATTERN = /^ses_/;

const describeLive = LIVE_API_KEY ? describe : describe.skip;

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  const payload = parts[1];
  if (!payload) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function tenantIdFromApiKey(token: string): string {
  const tenantId = parseJwtClaims(token)?.tenant_id;
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new Error(
      "STARCITE_LIVE_API_KEY must include a tenant_id claim for live tests"
    );
  }

  return tenantId;
}

describeLive("Starcite live API integration", () => {
  it("creates, appends, tails, and lists sessions against the live API", async () => {
    const apiKey = LIVE_API_KEY;
    if (!apiKey) {
      throw new Error("missing STARCITE_LIVE_API_KEY");
    }

    const tenantId = tenantIdFromApiKey(apiKey);
    const marker = `sdk-live-${Date.now()}`;
    const client = new Starcite({
      baseUrl: LIVE_API_BASE_URL,
      apiKey,
    });

    const session = await client.session({
      identity: new StarciteIdentity({
        tenantId,
        id: `sdk-live-agent-${Date.now()}`,
        type: "agent",
      }),
      title: "SDK live integration",
      metadata: {
        integration: marker,
      },
    });

    expect(session.id).toMatch(SESSION_ID_PATTERN);

    const appendResult = await session.append({
      text: "sdk live append",
    });
    expect(appendResult.seq).toBeGreaterThanOrEqual(1);

    const tailedSeqs: number[] = [];
    await session.tail(
      (event) => {
        tailedSeqs.push(event.seq);
      },
      {
        cursor: Math.max(appendResult.seq - 1, 0),
        follow: false,
        catchUpIdleMs: 800,
      }
    );

    expect(tailedSeqs).toContain(appendResult.seq);

    const listed = await client.listSessions({
      limit: 20,
      metadata: {
        integration: marker,
      },
    });
    expect(listed.sessions.some((item) => item.id === session.id)).toBe(true);
  }, 45_000);
});
