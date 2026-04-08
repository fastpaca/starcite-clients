import type { SessionArchivedFilter, SessionRecord } from "@starcite/sdk";
import {
  type CliRuntime,
  CliUsageError,
  type GlobalOptions,
  parseArgs,
  parseJsonObject,
  parsePositiveInteger,
  parseSessionMetadataFilters,
  trimString,
} from "../runtime";

export async function runSessionsCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const subcommand = `${args[0] ?? ""}`;

  switch (subcommand) {
    case "list":
      await runSessionsListCommand(args.slice(1), globalOptions, runtime);
      return;
    case "get":
      await runSessionsGetCommand(args.slice(1), globalOptions, runtime);
      return;
    case "update":
    case "patch":
      await runSessionsUpdateCommand(args.slice(1), globalOptions, runtime);
      return;
    case "archive":
      await runSessionsArchiveCommand(args.slice(1), globalOptions, runtime);
      return;
    case "unarchive":
      await runSessionsUnarchiveCommand(args.slice(1), globalOptions, runtime);
      return;
    default:
      throw new CliUsageError(
        "sessions requires one of: list, get, update, patch, archive, unarchive"
      );
  }
}

async function runSessionsListCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const parsed = parseArgs(
    {
      "--limit": String,
      "--cursor": String,
      "--metadata": String,
      "--archived": String,
    },
    args
  );

  if (parsed._.length > 0) {
    throw new CliUsageError(
      "sessions list does not accept positional arguments"
    );
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
    archived: parseArchivedFilter(parsed["--archived"]),
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

  runtime.logger.info("id\ttitle\tarchived\tcreated_at");
  for (const session of page.sessions) {
    runtime.logger.info(
      `${session.id}\t${session.title ?? ""}\t${formatArchivedValue(session.archived)}\t${session.created_at}`
    );
  }

  if (page.next_cursor) {
    runtime.logger.info(`next_cursor=${page.next_cursor}`);
  }
}

async function runSessionsGetCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const parsed = parseArgs({}, args);
  const sessionId = parseSessionIdArg(parsed._, "sessions get");
  const resolved = await runtime.resolveGlobalOptions(globalOptions);
  const record = await resolved.client.getSession(sessionId);
  writeSessionRecord(record, resolved.json, runtime);
}

async function runSessionsUpdateCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const parsed = parseArgs(
    {
      "--title": String,
      "--clear-title": Boolean,
      "--metadata": String,
      "--expected-version": String,
    },
    args
  );
  const sessionId = parseSessionIdArg(parsed._, "sessions update");

  if (parsed["--clear-title"] && parsed["--title"] !== undefined) {
    throw new CliUsageError("choose one of --title or --clear-title");
  }

  const metadata = parsed["--metadata"]
    ? parseJsonObject(parsed["--metadata"], "--metadata")
    : undefined;
  const title =
    parsed["--clear-title"] === true ? null : (parsed["--title"] ?? undefined);

  if (title === undefined && metadata === undefined) {
    throw new CliUsageError(
      "sessions update requires at least one of --title, --clear-title, or --metadata"
    );
  }

  const resolved = await runtime.resolveGlobalOptions(globalOptions);
  const record = await resolved.client.updateSession(sessionId, {
    title,
    metadata,
    expectedVersion: parsed["--expected-version"]
      ? parsePositiveInteger(parsed["--expected-version"], "--expected-version")
      : undefined,
  });
  writeSessionRecord(record, resolved.json, runtime);
}

async function runSessionsArchiveCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const parsed = parseArgs({}, args);
  const sessionId = parseSessionIdArg(parsed._, "sessions archive");
  const resolved = await runtime.resolveGlobalOptions(globalOptions);
  const record = await resolved.client.archiveSession(sessionId);
  writeSessionRecord(record, resolved.json, runtime);
}

async function runSessionsUnarchiveCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const parsed = parseArgs({}, args);
  const sessionId = parseSessionIdArg(parsed._, "sessions unarchive");
  const resolved = await runtime.resolveGlobalOptions(globalOptions);
  const record = await resolved.client.unarchiveSession(sessionId);
  writeSessionRecord(record, resolved.json, runtime);
}

function parseArchivedFilter(
  value: string | undefined
): SessionArchivedFilter | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "active":
    case "false":
      return false;
    case "archived":
    case "true":
      return true;
    case "all":
      return "all";
    default:
      throw new CliUsageError(
        "--archived must be one of: active, archived, all"
      );
  }
}

function parseSessionIdArg(args: readonly unknown[], usage: string): string {
  if (args.length !== 1) {
    throw new CliUsageError(`${usage} requires <sessionId>`);
  }

  const sessionId = `${args[0] ?? ""}`;
  if (sessionId.length === 0) {
    throw new CliUsageError(`${usage} requires <sessionId>`);
  }

  return sessionId;
}

function writeSessionRecord(
  record: SessionRecord,
  json: boolean,
  runtime: CliRuntime
): void {
  if (json) {
    runtime.writeJsonOutput(record, true);
    return;
  }

  runtime.logger.info(`id=${record.id}`);
  runtime.logger.info(`title=${JSON.stringify(record.title ?? null)}`);
  runtime.logger.info(`archived=${record.archived ?? false}`);
  if (record.last_seq !== undefined) {
    runtime.logger.info(`last_seq=${record.last_seq}`);
  }
  if (record.version !== undefined) {
    runtime.logger.info(`version=${record.version}`);
  }
  if (record.tenant_id) {
    runtime.logger.info(`tenant_id=${record.tenant_id}`);
  }
  runtime.logger.info(`created_at=${record.created_at}`);
  runtime.logger.info(`updated_at=${record.updated_at}`);
  if (record.creator_principal) {
    runtime.logger.info(
      `creator_principal=${JSON.stringify(record.creator_principal)}`
    );
  }
  runtime.logger.info(`metadata=${JSON.stringify(record.metadata)}`);
}

function formatArchivedValue(value: boolean | undefined): string {
  return value === undefined ? "" : `${value}`;
}
