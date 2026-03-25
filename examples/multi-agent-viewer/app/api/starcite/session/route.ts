import { NextResponse } from "next/server";
import { starcite } from "@/lib/agent";

export async function POST(request: Request): Promise<Response> {
  const { sessionId } = (await request.json()) as { sessionId?: string };

  const session = await starcite.session({
    identity: starcite.user({ id: "demo-user" }),
    id: sessionId?.trim() || undefined,
    title: "Research Swarm",
  });

  return NextResponse.json({ sessionId: session.id, token: session.token });
}
