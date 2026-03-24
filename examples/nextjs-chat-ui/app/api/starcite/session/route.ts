import { NextResponse } from "next/server";
import { Starcite } from "@starcite/sdk";

const starcite = new Starcite({
  apiKey: process.env.STARCITE_API_KEY!,
  baseUrl: process.env.STARCITE_BASE_URL || "https://api.starcite.io",
});

export async function POST(request: Request): Promise<Response> {
  const { sessionId } = (await request.json()) as { sessionId?: string };
  const user = starcite.user({
    // in prod: use the actual user id here
    id: "nextjs-demo-user",
  });

  const session = await starcite.session({
    identity: user,
    id: sessionId?.trim() || undefined,
  }
  );
  return NextResponse.json({ token: session.token, sessionId: session.id });
}
