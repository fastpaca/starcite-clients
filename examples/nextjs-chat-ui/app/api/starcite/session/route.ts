import { NextResponse } from "next/server";
import { starcite } from "@/lib/starcite";

export async function POST(request: Request): Promise<Response> {
  const { sessionId } = (await request.json()) as { sessionId?: string };
  const owner = starcite.agent({
    id: process.env.STARCITE_AGENT_ID || "nextjs-demo-agent",
  });
  const user = starcite.user({
    // in prod: use the actual user id here
    id: "nextjs-demo-user",
  });

  const ownerSession = await starcite.session({
    identity: owner,
    id: sessionId?.trim() || undefined,
    title: "Next.js demo chat",
  });

  const session = await starcite.session({
    identity: user,
    id: ownerSession.id,
  });

  return NextResponse.json({ token: session.token, sessionId: session.id });
}
