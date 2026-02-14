import {
  createStarciteClient,
  normalizeBaseUrl,
  type SessionEvent,
  StarciteApiError,
  type StarciteClient,
} from "@starcite/sdk";
import { Command, InvalidArgumentError } from "commander";
import { createConsola } from "consola";
import { z } from "zod";
import {
  buildSeqContextKey,
  resolveConfigDir,
  type StarciteCliConfig,
  StarciteCliStore,
} from "./store";
import {
  type CommandRunner,
  createDefaultPrompt,
  DEFAULT_API_PORT,
  defaultCommandRunner,
  type PromptAdapter,
  parsePortOption,
  runDownWizard,
  runUpWizard,
} from "./up";

interface GlobalOptions {
  baseUrl?: string;
  configDir?: string;
  token?: string;
  json: boolean;
}

interface ResolvedGlobalOptions {
  baseUrl: string;
  apiKey?: string;
  json: boolean;
  store: StarciteCliStore;
}

export interface LoggerLike {
  info(message: string): void;
  error(message: string): void;
}

interface CliDependencies {
  createClient?: (baseUrl: string, apiKey?: string) => StarciteClient;
  logger?: LoggerLike;
  prompt?: PromptAdapter;
  runCommand?: CommandRunner;
}

type CliJsonObject = Record<string, unknown>;

const defaultLogger: LoggerLike = createConsola();

const nonNegativeIntegerSchema = z.coerce.number().int().nonnegative();
const positiveIntegerSchema = z.coerce.number().int().positive();
const jsonObjectSchema = z.record(z.unknown());
const TRAILING_SLASHES_REGEX = /\/+$/;

type ConfigSetKey = "endpoint" | "producer-id" | "api-key";

function parseNonNegativeInteger(value: string, optionName: string): number {
  const parsed = nonNegativeIntegerSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidArgumentError(
      `${optionName} must be a non-negative integer`
    );
  }

  return parsed.data;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = positiveIntegerSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidArgumentError(`${optionName} must be a positive integer`);
  }

  return parsed.data;
}

function parsePort(value: string, optionName: string): number {
  return parsePortOption(value, optionName);
}

function parseEndpoint(value: string, optionName: string): string {
  const endpoint = trimString(value);
  if (!endpoint) {
    throw new InvalidArgumentError(`${optionName} cannot be empty`);
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new InvalidArgumentError(`${optionName} must be a valid URL`);
  }

  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new InvalidArgumentError(
      `${optionName} must use http:// or https://`
    );
  }

  return endpoint.replace(TRAILING_SLASHES_REGEX, "");
}

function parseConfigSetKey(value: string): ConfigSetKey {
  const normalized = value.trim().toLowerCase();

  if (["endpoint", "base-url", "base_url"].includes(normalized)) {
    return "endpoint";
  }

  if (["producer-id", "producer_id"].includes(normalized)) {
    return "producer-id";
  }

  if (["api-key", "api_key"].includes(normalized)) {
    return "api-key";
  }

  throw new InvalidArgumentError(
    "config key must be one of: endpoint, producer-id, api-key"
  );
}

function parseJsonOption<T>(
  value: string,
  schema: z.ZodType<T>,
  optionName: string,
  invalidShapeMessage: string
): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError(`${optionName} must be valid JSON`);
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    throw new InvalidArgumentError(
      `${optionName} must be ${invalidShapeMessage}`
    );
  }

  return result.data;
}

function parseJsonObject(value: string, optionName: string): CliJsonObject {
  return parseJsonOption(value, jsonObjectSchema, optionName, "a JSON object");
}

function parseEventRefs(value: string): CliJsonObject {
  return parseJsonObject(value, "--refs");
}

function parseSessionMetadataFilters(value: string): Record<string, string> {
  const parsed = parseJsonObject(value, "--metadata");
  const filters: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(parsed)) {
    if (key.trim().length === 0) {
      throw new InvalidArgumentError("--metadata keys must be non-empty");
    }

    if (typeof rawValue !== "string") {
      throw new InvalidArgumentError("--metadata values must be strings");
    }

    filters[key] = rawValue;
  }

  return filters;
}

function getGlobalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function trimString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveBaseUrl(
  config: StarciteCliConfig,
  options: GlobalOptions
): string {
  const defaultBaseUrl = `http://localhost:${DEFAULT_API_PORT}`;
  return (
    trimString(options.baseUrl) ??
    trimString(process.env.STARCITE_BASE_URL) ??
    trimString(config.baseUrl) ??
    defaultBaseUrl
  );
}

async function resolveGlobalOptions(
  command: Command
): Promise<ResolvedGlobalOptions> {
  const options = getGlobalOptions(command);
  const configDir = resolveConfigDir(options.configDir);
  const store = new StarciteCliStore(configDir);
  const config = await store.readConfig();
  const apiKey = trimString(options.token) ?? (await store.readApiKey());

  return {
    baseUrl: resolveBaseUrl(config, options),
    apiKey,
    json: options.json,
    store,
  };
}

async function promptForEndpoint(
  prompt: PromptAdapter,
  defaultEndpoint: string
): Promise<string> {
  while (true) {
    const answer = await prompt.input("Starcite endpoint URL", defaultEndpoint);

    try {
      return parseEndpoint(answer, "endpoint");
    } catch {
      // keep asking until valid
    }
  }
}

async function promptForApiKey(prompt: PromptAdapter): Promise<string> {
  const message = "Paste your Starcite API key";
  const answer = prompt.password
    ? await prompt.password(message)
    : await prompt.input(message, "");

  return trimString(answer) ?? "";
}

function formatTailEvent(event: SessionEvent): string {
  const actorLabel = event.agent ?? event.actor;

  if (event.text) {
    return `[${actorLabel}] ${event.text}`;
  }

  return `[${actorLabel}] ${JSON.stringify(event.payload)}`;
}

export function buildProgram(deps: CliDependencies = {}): Command {
  const createClient =
    deps.createClient ??
    ((baseUrl: string, apiKey?: string) =>
      createStarciteClient({
        baseUrl,
        apiKey,
      }));
  const logger = deps.logger ?? defaultLogger;
  const prompt = deps.prompt ?? createDefaultPrompt();
  const runCommand = deps.runCommand ?? defaultCommandRunner;

  const program = new Command();

  program
    .name("starcite")
    .description("Starcite CLI")
    .showHelpAfterError()
    .option("-u, --base-url <url>", "Starcite API base URL")
    .option("-k, --token <token>", "Starcite API key / service JWT")
    .option(
      "--config-dir <path>",
      "Starcite CLI config directory (default: ~/.starcite)"
    )
    .option("--json", "Output JSON");

  program
    .command("init")
    .description("Initialize Starcite CLI config for a remote instance")
    .option("--endpoint <url>", "Starcite endpoint URL")
    .option("--api-key <key>", "API key to store")
    .option("-y, --yes", "Skip prompts and only use provided options")
    .action(async function initAction(options: {
      endpoint?: string;
      apiKey?: string;
      yes?: boolean;
    }) {
      const { baseUrl, json, store } = await resolveGlobalOptions(this);

      const defaultEndpoint = parseEndpoint(baseUrl, "endpoint");
      let endpoint = defaultEndpoint;

      if (options.endpoint) {
        endpoint = parseEndpoint(options.endpoint, "--endpoint");
      } else if (!options.yes) {
        endpoint = await promptForEndpoint(prompt, defaultEndpoint);
      }

      await store.updateConfig({ baseUrl: endpoint });

      let apiKey = trimString(options.apiKey);

      if (!(apiKey || options.yes)) {
        apiKey = await promptForApiKey(prompt);
      }

      if (apiKey) {
        await store.saveApiKey(apiKey);
        await store.updateConfig({ apiKey: undefined });
      }

      if (json) {
        logger.info(
          JSON.stringify(
            {
              configDir: store.directory,
              endpoint,
              apiKeySaved: Boolean(apiKey),
            },
            null,
            2
          )
        );
        return;
      }

      logger.info(`Initialized Starcite CLI in ${store.directory}`);
      logger.info(`Endpoint set to ${endpoint}`);
      if (apiKey) {
        logger.info("API key saved. You can now run create/append/tail.");
      } else {
        logger.info("API key not set. Run `starcite auth login` when ready.");
      }
    });

  program
    .command("config")
    .description("Manage CLI configuration")
    .addCommand(
      new Command("set")
        .description("Set a configuration value")
        .argument("<key>", "endpoint | producer-id | api-key")
        .argument("<value>", "value to store")
        .action(async function configSetAction(key: string, value: string) {
          const { store } = await resolveGlobalOptions(this);
          const parsedKey = parseConfigSetKey(key);

          if (parsedKey === "endpoint") {
            const endpoint = parseEndpoint(value, "endpoint");
            await store.updateConfig({ baseUrl: endpoint });
            logger.info(`Endpoint set to ${endpoint}`);
            return;
          }

          if (parsedKey === "producer-id") {
            const producerId = trimString(value);
            if (!producerId) {
              throw new InvalidArgumentError("producer-id cannot be empty");
            }

            await store.updateConfig({ producerId });
            logger.info(`Producer ID set to ${producerId}`);
            return;
          }

          await store.saveApiKey(value);
          await store.updateConfig({ apiKey: undefined });
          logger.info("API key saved.");
        })
    )
    .addCommand(
      new Command("show")
        .description("Show current configuration")
        .action(async function configShowAction() {
          const { baseUrl, store } = await resolveGlobalOptions(this);
          const config = await store.readConfig();
          const apiKey = await store.readApiKey();
          const fromEnv = trimString(process.env.STARCITE_API_KEY);
          let apiKeySource = "unset";

          if (fromEnv) {
            apiKeySource = "env";
          } else if (apiKey) {
            apiKeySource = "stored";
          }

          logger.info(
            JSON.stringify(
              {
                endpoint: config.baseUrl ?? baseUrl,
                producerId: config.producerId ?? null,
                apiKey: apiKey ? "***" : null,
                apiKeySource,
                configDir: store.directory,
              },
              null,
              2
            )
          );
        })
    );

  program
    .command("auth")
    .description("Manage API key authentication")
    .addCommand(
      new Command("login")
        .description("Save an API key for authenticated requests")
        .option("--api-key <key>", "API key to store")
        .action(async function authLoginAction(options: { apiKey?: string }) {
          const { store } = await resolveGlobalOptions(this);
          let apiKey = trimString(options.apiKey);

          if (!apiKey) {
            apiKey = await promptForApiKey(prompt);
          }

          if (!apiKey) {
            throw new Error("API key cannot be empty");
          }

          await store.saveApiKey(apiKey);
          await store.updateConfig({ apiKey: undefined });
          logger.info("API key saved.");
        })
    )
    .addCommand(
      new Command("logout")
        .description("Remove the saved API key")
        .action(async function authLogoutAction() {
          const { store } = await resolveGlobalOptions(this);
          await store.clearApiKey();
          logger.info("Saved API key removed.");
        })
    )
    .addCommand(
      new Command("status")
        .description("Show authentication status")
        .action(async function authStatusAction() {
          const { store } = await resolveGlobalOptions(this);
          const apiKey = await store.readApiKey();
          const fromEnv = trimString(process.env.STARCITE_API_KEY);

          if (fromEnv) {
            logger.info("Authenticated via STARCITE_API_KEY.");
            return;
          }

          if (apiKey) {
            logger.info("Authenticated via saved API key.");
            return;
          }

          logger.info("No API key configured. Run `starcite auth login`.");
        })
    );

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
        .action(async function sessionsListAction(options: {
          limit?: number;
          cursor?: string;
          metadata?: string;
        }) {
          const { baseUrl, apiKey, json } = await resolveGlobalOptions(this);
          const client = apiKey
            ? createClient(baseUrl, apiKey)
            : createClient(baseUrl);

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
        })
    );

  program
    .command("up")
    .description("Start local Starcite services with Docker")
    .option("-y, --yes", "Skip confirmation prompts and use defaults")
    .option("--port <port>", "Starcite API port", (value) =>
      parsePort(value, "--port")
    )
    .option("--db-port <port>", "Postgres port", (value) =>
      parsePort(value, "--db-port")
    )
    .option("--image <image>", "Override Starcite image")
    .action(async function upAction(options: {
      yes?: boolean;
      port?: number;
      dbPort?: number;
      image?: string;
    }) {
      const { baseUrl, store } = await resolveGlobalOptions(this);

      await runUpWizard({
        baseUrl,
        logger,
        options,
        prompt,
        runCommand,
        store,
      });
    });

  program
    .command("down")
    .description("Stop and remove local Starcite services")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--no-volumes", "Keep Postgres volume data")
    .action(async function downAction(options: {
      yes?: boolean;
      volumes?: boolean;
    }) {
      const { store } = await resolveGlobalOptions(this);

      await runDownWizard({
        logger,
        options,
        prompt,
        runCommand,
        store,
      });
    });

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
      const { baseUrl, apiKey, json } = await resolveGlobalOptions(this);
      const client = apiKey
        ? createClient(baseUrl, apiKey)
        : createClient(baseUrl);
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
    });

  program
    .command("append <sessionId>")
    .description("Append an event")
    .option("--agent <agent>", "Agent name (high-level mode)")
    .option("--text <text>", "Text content (high-level mode)")
    .option("--type <type>", "Event type", "content")
    .option("--source <source>", "Event source")
    .option(
      "--producer-id <id>",
      "Producer identity (auto-generated if omitted)"
    )
    .option(
      "--producer-seq <seq>",
      "Producer sequence (defaults to persisted state, starting at 1)",
      (value) => parsePositiveInteger(value, "--producer-seq")
    )
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
        producerId?: string;
        producerSeq?: number;
        actor?: string;
        payload?: string;
        metadata?: string;
        refs?: string;
        idempotencyKey?: string;
        expectedSeq?: number;
      }
    ) {
      const { baseUrl, apiKey, json, store } = await resolveGlobalOptions(this);
      const client = apiKey
        ? createClient(baseUrl, apiKey)
        : createClient(baseUrl);
      const session = client.session(sessionId);

      const metadata = options.metadata
        ? parseJsonObject(options.metadata, "--metadata")
        : undefined;
      const refs = options.refs ? parseEventRefs(options.refs) : undefined;

      const highLevelMode =
        options.agent !== undefined || options.text !== undefined;
      const rawMode =
        options.actor !== undefined || options.payload !== undefined;

      if (highLevelMode && rawMode) {
        throw new Error(
          "Choose either high-level mode (--agent and --text) or raw mode (--actor and --payload), not both"
        );
      }

      const producerId = await store.resolveProducerId(options.producerId);
      const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
      const contextKey = buildSeqContextKey(
        normalizedBaseUrl,
        sessionId,
        producerId
      );

      const response = await store.withStateLock(async () => {
        const producerSeq =
          options.producerSeq ?? (await store.readNextSeq(contextKey));
        const appendOptions = {
          ...options,
          producerId,
          producerSeq,
        };

        const appendResponse = highLevelMode
          ? await appendHighLevel(session, appendOptions, metadata, refs)
          : await appendRaw(session, appendOptions, metadata, refs);

        await store.bumpNextSeq(contextKey, producerSeq);
        return appendResponse;
      });

      if (json) {
        logger.info(JSON.stringify(response, null, 2));
        return;
      }

      logger.info(
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
      const { baseUrl, apiKey, json } = await resolveGlobalOptions(this);
      const client = apiKey
        ? createClient(baseUrl, apiKey)
        : createClient(baseUrl);
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
          if (json) {
            logger.info(JSON.stringify(event));
          } else {
            logger.info(formatTailEvent(event));
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
    producerId: string;
    producerSeq: number;
    idempotencyKey?: string;
    expectedSeq?: number;
  },
  metadata?: CliJsonObject,
  refs?: CliJsonObject
) {
  if (!(options.agent && options.text)) {
    throw new Error(
      "--agent and --text are required for high-level append mode"
    );
  }
  return session.append({
    agent: options.agent,
    producerId: options.producerId,
    producerSeq: options.producerSeq,
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
    producerId: string;
    producerSeq: number;
    idempotencyKey?: string;
    expectedSeq?: number;
  },
  metadata?: CliJsonObject,
  refs?: CliJsonObject
) {
  if (!(options.actor && options.payload)) {
    throw new Error(
      "Raw append mode requires --actor and --payload, or use --agent and --text"
    );
  }
  return session.appendRaw({
    type: options.type,
    payload: parseJsonObject(options.payload, "--payload"),
    actor: options.actor,
    producer_id: options.producerId,
    producer_seq: options.producerSeq,
    source: options.source,
    metadata,
    refs,
    idempotency_key: options.idempotencyKey,
    expected_seq: options.expectedSeq,
  });
}

export async function run(
  argv = process.argv,
  deps: CliDependencies = {}
): Promise<void> {
  const program = buildProgram(deps);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof StarciteApiError) {
      const logger = deps.logger ?? defaultLogger;
      logger.error(`${error.code} (${error.status}): ${error.message}`);
      process.exitCode = 1;
      return;
    }

    if (error instanceof Error) {
      const logger = deps.logger ?? defaultLogger;
      logger.error(error.message);
      process.exitCode = 1;
      return;
    }

    const logger = deps.logger ?? defaultLogger;
    logger.error("Unknown error");
    process.exitCode = 1;
  }
}
