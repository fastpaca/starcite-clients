import { NextResponse } from "next/server";
import { starcite } from "@/lib/starcite";

export async function POST(request: Request): Promise<Response> {
  const { sessionId } = (await request.json()) as { sessionId?: string };
  const user = starcite.user({
    // in prod: use the actual user id here
    id: "nextjs-demo-user",
  });

  const session = await starcite.session({
    identity: user,
    id: sessionId?.trim() || undefined,
    title: "Next.js demo chat",
  });

  return NextResponse.json({ token: session.token, sessionId: session.id });
}
