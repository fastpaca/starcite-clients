import {
  StarciteApiError,
  StarciteClient,
} from "../packages/typescript-sdk/src/index.ts";

const DEFAULT_BASE_URL = "https://api.starcite.io";
const DEFAULT_TAIL_TIMEOUT_MS = 15_000;
const DEFAULT_TAIL_BATCH_SIZE = 50;

interface LiveSmokeResult {
  baseUrl: string;
  sessionId: string;
  listSessions: {
    ok: boolean;
    count?: number;
    nextCursor?: string | null;
    skipped?: boolean;
    reason?: string;
  };
  tailReplay: {
    ok: boolean;
    observedEvents: number;
    lifecycle: string[];
  };
}

function readRequiredApiKey(): string {
  const apiKey = process.env.STARCITE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "STARCITE_API_KEY is required (set it in your shell before running bun run smoke:live)"
    );
  }

  return apiKey;
}

function readBaseUrl(): string {
  return process.env.STARCITE_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function readTailTimeoutMs(): number {
  const raw = process.env.STARCITE_SMOKE_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_TAIL_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TAIL_TIMEOUT_MS;
}

function shouldRequireListSessions(): boolean {
  return process.env.STARCITE_SMOKE_REQUIRE_LIST === "1";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown error";
}

function isArchiveReadUnavailable(error: unknown): boolean {
  return (
    error instanceof StarciteApiError &&
    error.status === 503 &&
    error.code === "archive_read_unavailable"
  );
}

async function main(): Promise<void> {
  const apiKey = readRequiredApiKey();
  const baseUrl = readBaseUrl();
  const tailTimeoutMs = readTailTimeoutMs();
  const requireListSessions = shouldRequireListSessions();
  const client = new StarciteClient({ baseUrl, apiKey });

  const session = await client.create({
    title: `live-smoke-${new Date().toISOString()}`,
    metadata: {
      source: "scripts/live-smoke.ts",
    },
  });

  const result: LiveSmokeResult = {
    baseUrl,
    sessionId: session.id,
    listSessions: {
      ok: false,
    },
    tailReplay: {
      ok: false,
      observedEvents: 0,
      lifecycle: [],
    },
  };

  try {
    const page = await client.listSessions({ limit: 3 });
    result.listSessions = {
      ok: true,
      count: page.sessions.length,
      nextCursor: page.next_cursor,
    };
  } catch (error) {
    if (!requireListSessions && isArchiveReadUnavailable(error)) {
      result.listSessions = {
        ok: false,
        skipped: true,
        reason: "archive_read_unavailable",
      };
    } else {
      throw new Error(`listSessions() failed: ${toErrorMessage(error)}`);
    }
  }

  const lifecycleEvents: string[] = [];
  let observedEvents = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), tailTimeoutMs);

  try {
    for await (const batch of session.tailRawBatches({
      cursor: 0,
      follow: false,
      batchSize: DEFAULT_TAIL_BATCH_SIZE,
      signal: controller.signal,
      onLifecycleEvent: (event) => {
        lifecycleEvents.push(event.type);
      },
    })) {
      observedEvents += batch.length;
    }
  } finally {
    clearTimeout(timeout);
  }

  result.tailReplay = {
    ok: true,
    observedEvents,
    lifecycle: lifecycleEvents,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: toErrorMessage(error),
      },
      null,
      2
    )
  );
  process.exit(1);
});
