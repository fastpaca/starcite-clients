import { NextResponse } from "next/server";
import { starcite } from "@/lib/starcite";

export async function POST(request: Request): Promise<Response> {
  const { sessionId } = (await request.json()) as { sessionId?: string };
  const ownerSession = await starcite.session({
    identity: starcite.agent({ id: "coordinator" }),
    id: sessionId?.trim() || undefined,
    title: "Research Swarm",
  });

  const session = await starcite.session({
    identity: starcite.user({ id: "demo-user" }),
    id: ownerSession.id,
  });

  return NextResponse.json({ sessionId: session.id, token: session.token });
}
