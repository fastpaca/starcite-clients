import { NextResponse } from "next/server";
import { starcite } from "@/lib/starcite";

const debug = process.env.NEXTJS_CHAT_DEBUG === "1";

function dbg(...args: unknown[]): void {
  if (debug) {
    console.log("[nextjs-chat-debug]", new Date().toISOString(), ...args);
  }
}

dbg("session route loaded (shared starcite)", {
  pid: process.pid,
  baseUrl: process.env.STARCITE_BASE_URL || "https://api.starcite.io (default)",
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
  });

  dbg("POST /api/starcite/session minted", {
    sessionId: session.id,
    pid: process.pid,
    reusedSessionId: Boolean(sessionId?.trim()),
  });

  return NextResponse.json({ token: session.token, sessionId: session.id });
}
