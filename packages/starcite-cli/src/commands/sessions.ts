import { Command, InvalidArgumentError } from "commander";
import {
  type CliRuntime,
  parsePositiveInteger,
  parseSessionMetadataFilters,
} from "../runtime";

export function registerSessionsCommand(
  program: Command,
  runtime: CliRuntime
): void {
  program
    .command("sessions")
    .description("Manage sessions")
    .addCommand(
      new Command("list")
        .description("List sessions")
        .option("--limit <count>", "Maximum sessions to return", (value) =>
          parsePositiveInteger(value, "--limit")
        )
        .option("--cursor <cursor>", "Pagination cursor")
        .option("--metadata <json>", "Metadata filter JSON object")
        .action(async function (
          this: Command,
          options: {
            limit?: number;
            cursor?: string;
            metadata?: string;
          }
        ) {
          const resolved = await runtime.resolveGlobalOptions(this);
          const client = runtime.createSdkClient(resolved);
          const metadata = options.metadata
            ? parseSessionMetadataFilters(options.metadata)
            : undefined;

          const cursor = options.cursor?.trim();
          if (options.cursor !== undefined && !cursor) {
            throw new InvalidArgumentError("--cursor must be non-empty");
          }

          const page = await client.listSessions({
            limit: options.limit,
            cursor,
            metadata,
          });

          if (resolved.json) {
            runtime.writeJsonOutput(page, true);
            return;
          }

          if (page.sessions.length === 0) {
            runtime.logger.info("No sessions found.");
            return;
          }

          runtime.logger.info("id\ttitle\tcreated_at");
          for (const session of page.sessions) {
            runtime.logger.info(
              `${session.id}\t${session.title ?? ""}\t${session.created_at}`
            );
          }

          if (page.next_cursor) {
            runtime.logger.info(`next_cursor=${page.next_cursor}`);
          }
        })
    );
}
