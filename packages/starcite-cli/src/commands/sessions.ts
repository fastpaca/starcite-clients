import { Command, InvalidArgumentError } from "commander";
import {
  createClientForGlobals,
  parseJsonObject,
  parsePositiveInteger,
  parseSessionMetadataFilters,
  withResolvedGlobals,
} from "../cli-core";
import type { CommandRegistrationContext } from "../cli-types";

export function registerSessionsCommands(
  program: Command,
  context: CommandRegistrationContext
): void {
  const { createClient, logger } = context;

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
        .action(
          withResolvedGlobals(
            async (
              resolved,
              options: {
                limit?: number;
                cursor?: string;
                metadata?: string;
              }
            ) => {
              const { json } = resolved;
              const client = createClientForGlobals(createClient, resolved);

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

              if (json) {
                logger.info(JSON.stringify(page, null, 2));
                return;
              }

              if (page.sessions.length === 0) {
                logger.info("No sessions found.");
                return;
              }

              logger.info("id\ttitle\tcreated_at");
              for (const session of page.sessions) {
                logger.info(
                  `${session.id}\t${session.title ?? ""}\t${session.created_at}`
                );
              }

              if (page.next_cursor) {
                logger.info(`next_cursor=${page.next_cursor}`);
              }
            }
          )
        )
    );

  program
    .command("create")
    .description("Create a session")
    .option("--id <id>", "Session ID")
    .option("--title <title>", "Session title")
    .option("--metadata <json>", "Session metadata JSON object")
    .action(
      withResolvedGlobals(
        async (
          resolved,
          options: {
            id?: string;
            title?: string;
            metadata?: string;
          }
        ) => {
          const { json } = resolved;
          const client = createClientForGlobals(createClient, resolved);
          const metadata = options.metadata
            ? parseJsonObject(options.metadata, "--metadata")
            : undefined;

          const session = await client.create({
            id: options.id,
            title: options.title,
            metadata,
          });

          if (json) {
            logger.info(
              JSON.stringify(session.record ?? { id: session.id }, null, 2)
            );
            return;
          }

          logger.info(session.id);
        }
      )
    );
}
