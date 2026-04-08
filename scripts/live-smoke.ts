import {
  getStarciteConfig,
  resolveStarciteConfig,
  Starcite,
  StarciteApiError,
} from "../packages/typescript-sdk/src/index.ts";
const DEFAULT_TAIL_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_MS = 1000;

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
  };
}

function readStarciteRuntimeConfig(): {
  readonly apiKey: string;
  readonly authUrl?: string;
  readonly baseUrl: string;
} {
  const config = resolveStarciteConfig(getStarciteConfig());
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new Error(
      "STARCITE_API_KEY is required (set it in your shell before running bun run smoke:live)"
    );
  }

  return {
    ...config,
    apiKey,
  };
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
  const config = readStarciteRuntimeConfig();
  const tailTimeoutMs = readTailTimeoutMs();
  const requireListSessions = shouldRequireListSessions();
  const client = new Starcite(config);
  const session = await client.session({
    identity: client.agent({ id: "live-smoke" }),
    title: `live-smoke-${new Date().toISOString()}`,
    metadata: {
      source: "scripts/live-smoke.ts",
    },
  });

  const result: LiveSmokeResult = {
    baseUrl: config.baseUrl,
    sessionId: session.id,
    listSessions: {
      ok: false,
    },
    tailReplay: {
      ok: false,
      observedEvents: 0,
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

  let observedEvents = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), tailTimeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        stopEvents();
        stopGap();
        stopError();
        controller.signal.removeEventListener("abort", handleAbort);
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        session.disconnect();
      };

      const finish = () => {
        cleanup();
        resolve();
      };

      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };

      const resetIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }

        idleTimer = setTimeout(() => {
          finish();
        }, DEFAULT_SETTLE_MS);
      };

      const handleAbort = () => {
        fail(new Error(`tail replay timed out after ${tailTimeoutMs}ms`));
      };

      const stopError = session.on("error", (error) => {
        fail(error);
      });
      const stopGap = session.on("gap", (gap) => {
        fail(new Error(`tail gap reported: ${gap.reason}`));
      });
      const stopEvents = session.on("event", () => {
        observedEvents += 1;
        resetIdleTimer();
      });

      controller.signal.addEventListener("abort", handleAbort, { once: true });
      session
        .append({
          metadata: { source: "scripts/live-smoke.ts" },
          text: "live smoke tail event",
        })
        .catch((error) => {
          fail(error);
        });
    });
  } finally {
    clearTimeout(timeout);
  }

  result.tailReplay = {
    ok: true,
    observedEvents,
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
