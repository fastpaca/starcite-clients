import {
  type StarciteSession,
} from "@starcite/sdk";
import {
  type CliRuntime,
  CliUsageError,
  type GlobalOptions,
  parseArgs,
  parseNonNegativeInteger,
} from "../runtime";

const DEFAULT_CREATE_AGENT_ID = "starcite-cli";
const NO_FOLLOW_IDLE_MS = 1000;

function parseTailCursorArg(input: string, flagName: string): number {
  const parsedSeq = Number(input);
  if (!Number.isInteger(parsedSeq) || parsedSeq < 0) {
    throw new CliUsageError(
      `${flagName} must be a non-negative integer sequence number`
    );
  }

  return parsedSeq;
}

export async function runTailCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const parsed = parseArgs(
    {
      "--cursor": String,
      "--agent": String,
      "--limit": String,
      "--no-follow": Boolean,
    },
    args
  );
  const sessionId = `${parsed._[0] ?? ""}`;

  if (!sessionId) {
    throw new CliUsageError("tail requires <sessionId>");
  }

  const resolved = await runtime.resolveGlobalOptions(globalOptions);
  const abortController = new AbortController();
  const onSigint = () => {
    abortController.abort();
  };
  const cursor = parsed["--cursor"]
    ? parseTailCursorArg(parsed["--cursor"], "--cursor")
    : undefined;
  const limit = parsed["--limit"]
    ? parseNonNegativeInteger(parsed["--limit"], "--limit")
    : undefined;

  process.once("SIGINT", onSigint);

  try {
    const session = await resolved.client.session({
      identity: resolved.client.agent({ id: DEFAULT_CREATE_AGENT_ID }),
      id: sessionId,
    });

    await emitTailEvents({
      session,
      agent: parsed["--agent"],
      cursorSeq: cursor,
      follow: parsed["--no-follow"] !== true,
      limit,
      json: resolved.json,
      runtime,
      signal: abortController.signal,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function emitTailEvents({
  session,
  agent,
  cursorSeq,
  follow,
  limit,
  json,
  runtime,
  signal,
}: {
  session: StarciteSession;
  agent?: string;
  cursorSeq: number | undefined;
  follow: boolean;
  limit: number | undefined;
  json: boolean;
  runtime: CliRuntime;
  signal: AbortSignal;
}): Promise<void> {
  if (limit !== undefined && limit <= 0) {
    return;
  }

  return await new Promise<void>((resolve, reject) => {
    let emitted = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanup = () => {
      stopEvents();
      stopError();
      signal.removeEventListener("abort", handleAbort);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
    };

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const resetIdleTimer = () => {
      if (follow) {
        return;
      }

      if (idleTimer) {
        clearTimeout(idleTimer);
      }

      idleTimer = setTimeout(() => {
        finish();
      }, NO_FOLLOW_IDLE_MS);
    };

    const handleAbort = () => {
      finish();
    };

    const stopError = session.on("error", (error) => {
      fail(error);
    });
    const stopEvents = session.on(
      "event",
      (event) => {
        resetIdleTimer();

        if (cursorSeq !== undefined && event.seq < cursorSeq) {
          return;
        }

        if (limit !== undefined && emitted >= limit) {
          finish();
          return;
        }

        if (json) {
          runtime.writeJsonOutput(event);
        } else {
          runtime.logger.info(runtime.formatTailEvent(event));
        }

        emitted += 1;

        if (limit !== undefined && emitted >= limit) {
          finish();
        }
      },
      { agent }
    );

    signal.addEventListener("abort", handleAbort, { once: true });
    resetIdleTimer();
  });
}
