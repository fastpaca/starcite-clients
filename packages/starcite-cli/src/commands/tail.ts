import type { Command } from "commander";
import {
  type CliRuntime,
  DEFAULT_TAIL_BATCH_SIZE,
  parseNonNegativeInteger,
} from "../runtime";

export function registerTailCommand(
  program: Command,
  runtime: CliRuntime
): void {
  program
    .command("tail <sessionId>")
    .description("Tail events from a session")
    .option("--cursor <cursor>", "Replay cursor", (value) =>
      parseNonNegativeInteger(value, "--cursor")
    )
    .option("--agent <agent>", "Filter by agent name")
    .option("--limit <count>", "Stop after N events", (value) =>
      parseNonNegativeInteger(value, "--limit")
    )
    .option("--no-follow", "Exit after replaying stored events")
    .action(async function (
      this: Command,
      sessionId: string,
      options: {
        cursor?: number;
        agent?: string;
        limit?: number;
        follow: boolean;
      }
    ) {
      const resolved = await runtime.resolveGlobalOptions(this);
      const client = runtime.createSdkClient(resolved);
      const session = await runtime.resolveSession(
        client,
        resolved.apiKey,
        sessionId
      );

      const abortController = new AbortController();
      const onSigint = () => {
        abortController.abort();
      };

      process.once("SIGINT", onSigint);

      try {
        let emitted = 0;

        for await (const { event } of session.tail({
          cursor: options.cursor ?? 0,
          batchSize: DEFAULT_TAIL_BATCH_SIZE,
          agent: options.agent,
          follow: options.follow,
          signal: abortController.signal,
        })) {
          if (options.limit !== undefined && emitted >= options.limit) {
            abortController.abort();
            break;
          }

          if (resolved.json) {
            runtime.writeJsonOutput(event);
          } else {
            runtime.logger.info(runtime.formatTailEvent(event));
          }

          emitted += 1;

          if (options.limit !== undefined && emitted >= options.limit) {
            abortController.abort();
          }
        }
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
    });
}
