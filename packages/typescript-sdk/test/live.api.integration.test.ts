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
  it("receives session.created and session.activated lifecycle events against the live API", async () => {
    const apiKey = LIVE_API_KEY;
    if (!apiKey) {
      throw new Error("missing STARCITE_LIVE_API_KEY");
    }

    const tenantId = tenantIdFromApiKey(apiKey);
    const marker = `sdk-live-lifecycle-${Date.now()}`;
    const client = new Starcite({
      baseUrl: LIVE_API_BASE_URL,
      apiKey,
    });

    const createdEvents: Array<{
      metadata: Record<string, unknown>;
      session_id: string;
      tenant_id: string;
    }> = [];
    const activatedSessionIds = new Set<string>();
    let createdSessionId: string | undefined;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for lifecycle events; created=${createdEvents.map((event) => event.session_id).join(",")} activated=${[...activatedSessionIds].join(",")}`
          )
        );
      }, 20_000);

      const cleanup = () => {
        stopCreated();
        stopActivated();
        stopError();
        clearTimeout(timeout);
      };

      const settle = (callback: () => void) => {
        cleanup();
        callback();
      };

      const maybeResolve = () => {
        if (!createdSessionId) {
          return;
        }

        const created = createdEvents.find((event) => {
          return event.session_id === createdSessionId;
        });
        if (created && activatedSessionIds.has(createdSessionId)) {
          settle(resolve);
        }
      };

      const stopCreated = client.on("session.created", (event) => {
        if (event.metadata.integration !== marker) {
          return;
        }

        createdEvents.push(event);
        maybeResolve();
      });
      const stopActivated = client.on("session.activated", (event) => {
        activatedSessionIds.add(event.session_id);
        maybeResolve();
      });
      const stopError = client.on("error", (error) => {
        settle(() => {
          reject(error);
        });
      });

      const createSession = async () => {
        try {
          await new Promise((resolveJoin) => {
            setTimeout(resolveJoin, 1000);
          });

          const session = await client.session({
            identity: new StarciteIdentity({
              tenantId,
              id: `sdk-live-agent-${Date.now()}`,
              type: "agent",
            }),
            title: "SDK live lifecycle integration",
            metadata: {
              integration: marker,
            },
          });

          createdSessionId = session.id;
          maybeResolve();
        } catch (error) {
          settle(() => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        }
      };

      createSession().catch((error) => {
        settle(() => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    });

    const created = createdEvents.find((event) => {
      return event.session_id === createdSessionId;
    });

    expect(createdSessionId).toMatch(SESSION_ID_PATTERN);
    expect(created?.tenant_id).toBe(tenantId);
    expect(created?.metadata.integration).toBe(marker);
    expect(activatedSessionIds.has(createdSessionId ?? "")).toBe(true);
  }, 45_000);

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

    const tailedSeqs = await new Promise<number[]>((resolve, reject) => {
      const seen: number[] = [];
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        stopEvents();
        stopError();
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        session.disconnect();
      };

      const settle = (callback: () => void) => {
        cleanup();
        callback();
      };

      const armIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }

        idleTimer = setTimeout(() => {
          settle(() => {
            resolve(seen);
          });
        }, 800);
      };

      const stopError = session.on("error", (error) => {
        settle(() => {
          reject(error);
        });
      });
      const stopEvents = session.on("event", (event) => {
        seen.push(event.seq);
        armIdle();
      });

      armIdle();
    });

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
