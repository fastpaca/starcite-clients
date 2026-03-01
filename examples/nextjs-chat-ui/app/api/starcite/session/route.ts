import { decodeJwt } from "jose";
import { Starcite, StarciteIdentity } from "@starcite/sdk";
import { NextResponse } from "next/server";
import { registerSession } from "@/agent";

export const runtime = "nodejs";
const defaultBaseUrl = "https://anor-ai.starcite.io";

export async function POST(request: Request): Promise<Response> {
  const { sessionId } = (await request.json()) as { sessionId?: string };
  const apiKey = process.env.STARCITE_API_KEY ?? process.env.STARCITE_API_TOKEN!;
  const claims = decodeJwt(apiKey) as {
    tenant_id?: string;
    principal_id?: string;
    principal_type?: "user" | "agent";
    sub?: string;
  };

  const starcite = new Starcite({
    apiKey,
    baseUrl: process.env.STARCITE_BASE_URL || defaultBaseUrl,
  });

  const identity = new StarciteIdentity({
    tenantId: claims.tenant_id!,
    id: claims.principal_id ?? claims.sub ?? "nextjs-demo-user",
    type: claims.principal_type === "agent" ? "agent" : "user",
  });

  const session = await starcite.session({
    identity,
    id: sessionId?.startsWith("ses_") ? sessionId : undefined,
    title: "Next.js demo chat",
  });
  registerSession(session.id);

  return NextResponse.json({ token: session.token, sessionId: session.id });
}
