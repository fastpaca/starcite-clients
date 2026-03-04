import { NextResponse } from "next/server";
import { registerSession } from "@/agent";
import { Starcite } from "@starcite/sdk";

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.STARCITE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing STARCITE_API_KEY for /api/starcite/session");
  }

  const starcite = new Starcite({
    apiKey,
    baseUrl: process.env.STARCITE_BASE_URL || "https://api.starcite.io",
  });
  const { sessionId } = (await request.json()) as { sessionId?: string };
  const user = starcite.user({
    // in prod: use the actual user id here
    id: "nextjs-demo-user",
  });

  const session = await starcite.session({
    identity: user,
    id: sessionId,
  });

  // register it locally with the web server so we can respond
  // to user queries
  await registerSession(session.id);

  return NextResponse.json({ token: session.token, sessionId: session.id });
}
