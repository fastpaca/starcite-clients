import {
  SessionLogConflictError,
  SessionLogGapError,
  type StarciteSession,
} from "@starcite/sdk";
import {
  type CliRuntime,
  CliUsageError,
  DEFAULT_TAIL_BATCH_SIZE,
  type GlobalOptions,
  parseArgs,
  parseNonNegativeInteger,
} from "../runtime";

const DEFAULT_CREATE_AGENT_ID = "starcite-cli";

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
    ? parseNonNegativeInteger(parsed["--cursor"], "--cursor")
    : 0;
  const limit = parsed["--limit"]
    ? parseNonNegativeInteger(parsed["--limit"], "--limit")
    : undefined;

  process.once("SIGINT", onSigint);

  try {
    let retriedAfterStoreReset = false;

    while (true) {
      const session = await resolved.client.session({
        identity: resolved.client.agent({ id: DEFAULT_CREATE_AGENT_ID }),
        id: sessionId,
      });

      try {
        await emitTailEvents({
          session,
          agent: parsed["--agent"],
          cursor,
          follow: parsed["--no-follow"] !== true,
          limit,
          json: resolved.json,
          runtime,
          signal: abortController.signal,
        });
        return;
      } catch (error) {
        const isStaleStoreConflict =
          error instanceof SessionLogConflictError ||
          error instanceof SessionLogGapError;

        if (!(isStaleStoreConflict && !retriedAfterStoreReset)) {
          throw error;
        }

        retriedAfterStoreReset = true;
        resolved.store.clearSession(resolved.baseUrl, sessionId);
        runtime.logger.error(
          `Warning: cleared stale local session cache for '${sessionId}' and retried tail.`
        );
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function emitTailEvents({
  session,
  agent,
  cursor,
  follow,
  limit,
  json,
  runtime,
  signal,
}: {
  session: StarciteSession;
  agent?: string;
  cursor: number;
  follow: boolean;
  limit: number | undefined;
  json: boolean;
  runtime: CliRuntime;
  signal: AbortSignal;
}): Promise<void> {
  let emitted = 0;

  for await (const { event } of session.tail({
    cursor,
    batchSize: DEFAULT_TAIL_BATCH_SIZE,
    agent,
    follow,
    signal,
  })) {
    if (limit !== undefined && emitted >= limit) {
      return;
    }

    if (json) {
      runtime.writeJsonOutput(event);
    } else {
      runtime.logger.info(runtime.formatTailEvent(event));
    }

    emitted += 1;

    if (limit !== undefined && emitted >= limit) {
      return;
    }
  }
}
