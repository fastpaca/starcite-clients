import {
  type CliRuntime,
  CliUsageError,
  type GlobalOptions,
  parseArgs,
  parsePositiveInteger,
  parseSessionMetadataFilters,
  trimString,
} from "../runtime";

export async function runSessionsCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const parsed = parseArgs(
    {
      "--limit": String,
      "--cursor": String,
      "--metadata": String,
    },
    args
  );

  if (`${parsed._[0] ?? ""}` !== "list") {
    throw new CliUsageError("sessions requires `list`");
  }

  const cursor = trimString(parsed["--cursor"]);
  if (parsed["--cursor"] !== undefined && !cursor) {
    throw new CliUsageError("--cursor must be non-empty");
  }

  const resolved = await runtime.resolveGlobalOptions(globalOptions);
  const page = await resolved.client.listSessions({
    limit: parsed["--limit"]
      ? parsePositiveInteger(parsed["--limit"], "--limit")
      : undefined,
    cursor,
    metadata: parsed["--metadata"]
      ? parseSessionMetadataFilters(parsed["--metadata"])
      : undefined,
  });

  runtime.logger.error(
    "Warning: `sessions list` is a bad call to use in production."
  );

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
}
