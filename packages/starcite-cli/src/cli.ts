import {
  createStarciteClient,
  type EventRefs,
  type JsonObject,
  type JsonValue,
  type SessionEvent,
  StarciteApiError,
  type StarciteClient,
} from "@starcite/sdk";
import { Command, InvalidArgumentError } from "commander";

interface GlobalOptions {
  baseUrl: string;
  json: boolean;
}

export interface CliLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface CliDependencies {
  createClient(baseUrl: string): StarciteClient;
  logger: CliLogger;
}

const defaultDependencies: CliDependencies = {
  createClient(baseUrl: string): StarciteClient {
    return createStarciteClient({ baseUrl });
  },
  logger: {
    info(message: string): void {
      console.log(message);
    },
    error(message: string): void {
      console.error(message);
    },
  },
};

function parseNonNegativeInteger(value: string, optionName: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(
      `${optionName} must be a non-negative integer`
    );
  }

  return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function parseJsonObject(value: string, optionName: string): JsonObject {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError(`${optionName} must be valid JSON`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !isJsonValue(parsed)
  ) {
    throw new InvalidArgumentError(`${optionName} must be a JSON object`);
  }

  return parsed as JsonObject;
}

function getClient(command: Command, deps: CliDependencies): StarciteClient {
  const options = command.optsWithGlobals() as GlobalOptions;
  return deps.createClient(options.baseUrl);
}

function outputIsJson(command: Command): boolean {
  const options = command.optsWithGlobals() as GlobalOptions;
  return options.json;
}

function formatTailEvent(event: SessionEvent): string {
  const actorLabel = event.agent ?? event.actor;

  if (event.text) {
    return `[${actorLabel}] ${event.text}`;
  }

  return `[${actorLabel}] ${JSON.stringify(event.payload)}`;
}

export function buildProgram(
  partialDependencies: Partial<CliDependencies> = {}
): Command {
  const deps: CliDependencies = {
    ...defaultDependencies,
    ...partialDependencies,
    logger: {
      ...defaultDependencies.logger,
      ...partialDependencies.logger,
    },
  };

  const program = new Command();

  program
    .name("starcite")
    .description("Starcite CLI")
    .showHelpAfterError()
    .option(
      "-u, --base-url <url>",
      "Starcite API base URL",
      process.env.STARCITE_BASE_URL ?? "http://localhost:4000"
    )
    .option("--json", "Output JSON");

  program
    .command("create")
    .description("Create a session")
    .option("--id <id>", "Session ID")
    .option("--title <title>", "Session title")
    .option("--metadata <json>", "Session metadata JSON object")
    .action(async function createAction(options: {
      id?: string;
      title?: string;
      metadata?: string;
    }) {
      const client = getClient(this, deps);
      const metadata = options.metadata
        ? parseJsonObject(options.metadata, "--metadata")
        : undefined;

      const session = await client.create({
        id: options.id,
        title: options.title,
        metadata,
      });

      if (outputIsJson(this)) {
        deps.logger.info(
          JSON.stringify(session.record ?? { id: session.id }, null, 2)
        );
        return;
      }

      deps.logger.info(session.id);
    });

  program
    .command("append <sessionId>")
    .description("Append an event")
    .option("--agent <agent>", "Agent name (high-level mode)")
    .option("--text <text>", "Text content (high-level mode)")
    .option("--type <type>", "Event type", "content")
    .option("--source <source>", "Event source")
    .option("--actor <actor>", "Raw actor field (raw mode)")
    .option("--payload <json>", "Raw payload JSON object (raw mode)")
    .option("--metadata <json>", "Event metadata JSON object")
    .option("--refs <json>", "Event refs JSON object")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--expected-seq <seq>", "Expected sequence", (value) =>
      parseNonNegativeInteger(value, "--expected-seq")
    )
    .action(async function appendAction(
      sessionId: string,
      options: {
        agent?: string;
        text?: string;
        type: string;
        source?: string;
        actor?: string;
        payload?: string;
        metadata?: string;
        refs?: string;
        idempotencyKey?: string;
        expectedSeq?: number;
      }
    ) {
      const client = getClient(this, deps);
      const session = client.session(sessionId);

      const metadata = options.metadata
        ? parseJsonObject(options.metadata, "--metadata")
        : undefined;
      const refs = options.refs
        ? parseJsonObject(options.refs, "--refs")
        : undefined;

      const response =
        options.agent || options.text
          ? await appendHighLevel(session, options, metadata, refs)
          : await appendRaw(session, options, metadata, refs);

      if (outputIsJson(this)) {
        deps.logger.info(JSON.stringify(response, null, 2));
        return;
      }

      deps.logger.info(
        `seq=${response.seq} last_seq=${response.last_seq} deduped=${response.deduped}`
      );
    });

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
    .action(async function tailAction(
      sessionId: string,
      options: {
        cursor?: number;
        agent?: string;
        limit?: number;
      }
    ) {
      const client = getClient(this, deps);
      const session = client.session(sessionId);

      const abortController = new AbortController();
      const onSigint = () => {
        abortController.abort();
      };

      process.once("SIGINT", onSigint);

      try {
        let emitted = 0;

        for await (const event of session.tail({
          cursor: options.cursor ?? 0,
          agent: options.agent,
          signal: abortController.signal,
        })) {
          if (outputIsJson(this)) {
            deps.logger.info(JSON.stringify(event));
          } else {
            deps.logger.info(formatTailEvent(event));
          }

          emitted += 1;

          if (options.limit !== undefined && emitted >= options.limit) {
            abortController.abort();
            break;
          }
        }
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
    });

  return program;
}

function appendHighLevel(
  session: ReturnType<StarciteClient["session"]>,
  options: {
    agent?: string;
    text?: string;
    type: string;
    source?: string;
    idempotencyKey?: string;
    expectedSeq?: number;
  },
  metadata?: JsonObject,
  refs?: EventRefs
) {
  if (!(options.agent && options.text)) {
    throw new Error(
      "--agent and --text are required for high-level append mode"
    );
  }

  return session.append({
    agent: options.agent,
    text: options.text,
    type: options.type,
    source: options.source,
    metadata,
    refs,
    idempotencyKey: options.idempotencyKey,
    expectedSeq: options.expectedSeq,
  });
}

function appendRaw(
  session: ReturnType<StarciteClient["session"]>,
  options: {
    actor?: string;
    payload?: string;
    type: string;
    source?: string;
    idempotencyKey?: string;
    expectedSeq?: number;
  },
  metadata?: JsonObject,
  refs?: EventRefs
) {
  if (!options.actor) {
    throw new Error(
      "Raw append mode requires --actor and --payload, or use --agent and --text"
    );
  }

  if (!options.payload) {
    throw new Error(
      "Raw append mode requires --payload JSON, or use --agent and --text"
    );
  }

  return session.appendRaw({
    type: options.type,
    payload: parseJsonObject(options.payload, "--payload"),
    actor: options.actor,
    source: options.source,
    metadata,
    refs,
    idempotency_key: options.idempotencyKey,
    expected_seq: options.expectedSeq,
  });
}

export async function run(
  argv = process.argv,
  partialDependencies: Partial<CliDependencies> = {}
): Promise<void> {
  const deps: CliDependencies = {
    ...defaultDependencies,
    ...partialDependencies,
    logger: {
      ...defaultDependencies.logger,
      ...partialDependencies.logger,
    },
  };

  const program = buildProgram(deps);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof StarciteApiError) {
      deps.logger.error(`${error.code} (${error.status}): ${error.message}`);
      process.exitCode = 1;
      return;
    }

    if (error instanceof Error) {
      deps.logger.error(error.message);
      process.exitCode = 1;
      return;
    }

    deps.logger.error("Unknown error");
    process.exitCode = 1;
  }
}
