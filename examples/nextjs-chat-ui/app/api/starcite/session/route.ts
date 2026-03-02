import { decodeJwt } from "jose";
import { StarciteIdentity } from "@starcite/sdk";
import { NextResponse } from "next/server";
import { registerSession } from "@/agent";
import { getApiKey, getServerStarcite } from "@/lib/starcite-server";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const { sessionId } = (await request.json()) as { sessionId?: string };
  const requestedSessionId = sessionId?.trim();
  const claims = decodeJwt(getApiKey()) as {
    tenant_id?: string;
    principal_id?: string;
    principal_type?: "user" | "agent";
    sub?: string;
  };

  const identity = new StarciteIdentity({
    tenantId: claims.tenant_id!,
    id: claims.principal_id ?? claims.sub ?? "nextjs-demo-user",
    type: claims.principal_type === "agent" ? "agent" : "user",
  });

  const session = await getServerStarcite().session({
    identity,
    id:
      requestedSessionId && requestedSessionId.length > 0
        ? requestedSessionId
        : undefined,
    title: "Next.js demo chat",
  });
  registerSession(session.id);

  return NextResponse.json({ token: session.token, sessionId: session.id });
}
