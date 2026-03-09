import { NextResponse } from "next/server";

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.STARCITE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing STARCITE_API_KEY for /api/starcite/viewer-token");
  }

  const body = (await request.json()) as {
    sessionId?: unknown;
    interactive?: unknown;
  };
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const interactive = body.interactive === true;

  if (sessionId.length === 0) {
    return NextResponse.json(
      { error: "sessionId is required" },
      { status: 400 }
    );
  }

  const authUrl = process.env.STARCITE_AUTH_URL ?? deriveAuthUrl(apiKey);
  const response = await fetch(`${authUrl}/api/v1/session-tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      principal: {
        id: interactive ? "web-user" : "viewer",
        type: "user",
      },
      scopes: interactive
        ? ["session:read", "session:append"]
        : ["session:read"],
      session_id: sessionId,
    }),
  });

  if (!response.ok) {
    return NextResponse.json(
      {
        error: `Viewer token request failed (${response.status}): ${await response.text()}`,
      },
      { status: response.status }
    );
  }

  const payload = (await response.json()) as { token: string };

  return NextResponse.json({
    sessionId,
    token: payload.token,
  });
}

function deriveAuthUrl(apiKey: string): string {
  const payload = apiKey.split(".")[1];
  if (!payload) {
    return "https://starcite.ai";
  }

  const decoded = JSON.parse(
    Buffer.from(
      payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "="),
      "base64url"
    ).toString("utf8")
  ) as { iss?: string };

  return decoded.iss ?? "https://starcite.ai";
}
