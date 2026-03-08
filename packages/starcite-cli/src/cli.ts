import {
  Starcite,
  StarciteApiError,
  StarciteIdentity,
  type StarciteSession,
  type TailEvent,
} from "@starcite/sdk";
import { Command, InvalidArgumentError } from "commander";
import { createConsola } from "consola";
import { z } from "zod";
import starciteCliPackage from "../package.json";
import {
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

interface StdoutLike {
  write(message: string): void;
}

interface CliDependencies {
  createClient?: (
    baseUrl: string,
    apiKey?: string,
    store?: StarciteCliStore
  ) => Starcite;
  logger?: LoggerLike;
  stdout?: StdoutLike;
  prompt?: PromptAdapter;
  runCommand?: CommandRunner;
}

type CliJsonObject = Record<string, unknown>;

const defaultLogger: LoggerLike = createConsola();
const defaultStdout: StdoutLike = {
  write(message: string) {
    process.stdout.write(message);
  },
};
const cliVersion = starciteCliPackage.version;

const nonNegativeIntegerSchema = z.coerce.number().int().nonnegative();
const positiveIntegerSchema = z.coerce.number().int().positive();
const jsonObjectSchema = z.record(z.unknown());
const GlobalOptionsSchema = z.object({
  baseUrl: z.string().optional(),
  configDir: z.string().optional(),
  token: z.string().optional(),
  json: z.boolean().optional().default(false),
});
const TRAILING_SLASHES_REGEX = /\/+$/;
const DEFAULT_TAIL_BATCH_SIZE = 256;
const DEFAULT_CREATE_AGENT_ID = "starcite-cli";

type ConfigSetKey = "endpoint" | "api-key";

interface AppendCommandOptions {
  agent?: string;
  user?: string;
  text?: string;
  type: string;
  source?: string;
  payload?: string;
  metadata?: string;
  refs?: string;
  idempotencyKey?: string;
  expectedSeq?: number;
}

interface AppendIdentitySelection {
  type: "agent" | "user";
  id: string;
}

interface ResolvedAppendInput {
  identity?: AppendIdentitySelection;
  payload: CliJsonObject;
}

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

  if (["api-key", "api_key"].includes(normalized)) {
    return "api-key";
  }

  throw new InvalidArgumentError(
    "config key must be one of: endpoint, api-key"
  );
}

function parseJsonObject(value: string, optionName: string): CliJsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError(`${optionName} must be valid JSON`);
  }

  const result = jsonObjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidArgumentError(`${optionName} must be a JSON object`);
  }

  return result.data;
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
  const parsed = GlobalOptionsSchema.safeParse(command.optsWithGlobals());
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "invalid global options";
    throw new InvalidArgumentError(`Failed to parse global options: ${issue}`);
  }

  return parsed.data;
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

function formatTailEvent(event: TailEvent): string {
  const actorLabel = event.actor.startsWith("agent:")
    ? event.actor.slice("agent:".length)
    : event.actor;
  const maybeText = event.payload?.text;

  if (typeof maybeText === "string") {
    return `[${actorLabel}] ${maybeText}`;
  }

  return `[${actorLabel}] ${JSON.stringify(event.payload)}`;
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  const payload = parts[1];
  if (!payload) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function tokenTenantId(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }

  const claims = parseJwtClaims(token);
  const tenantId = claims?.tenant_id;
  if (typeof tenantId !== "string") {
    return undefined;
  }

  const trimmed = tenantId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function tokenScopes(token: string): Set<string> {
  const claims = parseJwtClaims(token);
  if (!claims) {
    return new Set();
  }

  const scopes = new Set<string>();
  const scopeClaim = claims.scope;
  if (typeof scopeClaim === "string") {
    for (const scope of scopeClaim.split(" ")) {
      if (scope.length > 0) {
        scopes.add(scope);
      }
    }
  }

  const scopesClaim = claims.scopes;
  if (Array.isArray(scopesClaim)) {
    for (const scope of scopesClaim) {
      if (typeof scope === "string" && scope.length > 0) {
        scopes.add(scope);
      }
    }
  }

  return scopes;
}

function shouldAutoIssueSessionToken(token: string): boolean {
  const scopes = tokenScopes(token);
  return scopes.has("auth:issue");
}

function resolveAppendInput(
  options: AppendCommandOptions
): ResolvedAppendInput {
  const agent = trimString(options.agent);
  const user = trimString(options.user);

  if (agent && user) {
    throw new InvalidArgumentError("Choose either --agent or --user, not both");
  }

  const text = trimString(options.text);
  const payload = trimString(options.payload);

  if (text && payload) {
    throw new InvalidArgumentError(
      "Choose either --text or --payload, not both"
    );
  }

  if (!(text || payload)) {
    throw new InvalidArgumentError(
      "append requires either --text or --payload"
    );
  }

  let identity: AppendIdentitySelection | undefined;
  if (agent) {
    identity = { type: "agent", id: agent };
  } else if (user) {
    identity = { type: "user", id: user };
  }

  if (text) {
    return {
      identity,
      payload: { text },
    };
  }

  if (!payload) {
    throw new InvalidArgumentError(
      "append requires either --text or --payload"
    );
  }

  return {
    identity,
    payload: parseJsonObject(payload, "--payload"),
  };
}

function toApiBaseUrlForContext(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new InvalidArgumentError("base URL must use http:// or https://");
  }

  const normalized = parsed.toString().replace(TRAILING_SLASHES_REGEX, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function buildSessionTokenContextKey(
  baseUrl: string,
  sessionId: string,
  identity: AppendIdentitySelection
): string {
  return `${toApiBaseUrlForContext(baseUrl)}::${sessionId}::${identity.type}::${identity.id}`;
}

function writeJsonOutput(
  stdout: StdoutLike,
  value: unknown,
  pretty = false
): void {
  const serialized = JSON.stringify(value, null, pretty ? 2 : undefined);
  if (serialized === undefined) {
    throw new Error("Failed to serialize JSON output");
  }

  stdout.write(`${serialized}\n`);
}

async function resolveSession(
  client: Starcite,
  apiKey: string | undefined,
  sessionId: string
) {
  if (!apiKey) {
    throw new InvalidArgumentError(
      "append/tail require --token or a saved API key"
    );
  }

  if (shouldAutoIssueSessionToken(apiKey)) {
    return await client.session({
      identity: resolveCreateIdentity(apiKey),
      id: sessionId,
    });
  }

  const session = client.session({ token: apiKey });
  if (session.id !== sessionId) {
    throw new InvalidArgumentError(
      `session token is bound to '${session.id}', expected '${sessionId}'`
    );
  }

  return session;
}

function resolveAppendIdentity(
  apiKey: string | undefined,
  identity: AppendIdentitySelection
): StarciteIdentity {
  const tenantId = tokenTenantId(apiKey);
  if (!tenantId) {
    throw new InvalidArgumentError(
      "session identity binding requires an API key with tenant_id claims"
    );
  }

  return new StarciteIdentity({
    tenantId,
    id: identity.id,
    type: identity.type,
  });
}

function matchesAppendIdentity(
  identity: StarciteIdentity,
  selection: AppendIdentitySelection
): boolean {
  return identity.type === selection.type && identity.id === selection.id;
}

async function resolveAppendSession(input: {
  client: Starcite;
  store: StarciteCliStore;
  baseUrl: string;
  apiKey: string | undefined;
  sessionId: string;
  identity: AppendIdentitySelection;
}): Promise<StarciteSession> {
  const { client, store, baseUrl, apiKey, sessionId, identity } = input;

  if (!apiKey) {
    throw new InvalidArgumentError(
      "append/tail require --token or a saved API key"
    );
  }

  if (!shouldAutoIssueSessionToken(apiKey)) {
    const session = await resolveSession(client, apiKey, sessionId);
    if (!matchesAppendIdentity(session.identity, identity)) {
      throw new InvalidArgumentError(
        `session token is bound to ${session.identity.type} '${session.identity.id}', expected ${identity.type} '${identity.id}'`
      );
    }
    return session;
  }

  const contextKey = buildSessionTokenContextKey(baseUrl, sessionId, identity);
  const cachedToken = await store.readSessionToken(contextKey);

  if (cachedToken) {
    try {
      const cachedSession = client.session({ token: cachedToken });
      if (
        cachedSession.id === sessionId &&
        matchesAppendIdentity(cachedSession.identity, identity)
      ) {
        return cachedSession;
      }
    } catch {
      // Fall through to re-issuing a fresh token below.
    }

    await store.clearSessionToken(contextKey);
  }

  const session = await client.session({
    identity: resolveAppendIdentity(apiKey, identity),
    id: sessionId,
  });
  await store.saveSessionToken(contextKey, session.token);
  return session;
}

function resolveCreateIdentity(
  apiKey: string | undefined,
  agentId = DEFAULT_CREATE_AGENT_ID
): StarciteIdentity {
  const tenantId = tokenTenantId(apiKey);
  if (!tenantId) {
    throw new InvalidArgumentError(
      "session identity binding requires an API key with tenant_id claims"
    );
  }

  return new StarciteIdentity({
    tenantId,
    id: agentId,
    type: "agent",
  });
}

class StarciteCliApp {
  private readonly createClient: (
    baseUrl: string,
    apiKey?: string,
    store?: StarciteCliStore
  ) => Starcite;
  private readonly logger: LoggerLike;
  private readonly stdout: StdoutLike;
  private readonly prompt: PromptAdapter;
  private readonly runCommand: CommandRunner;

  constructor(deps: CliDependencies = {}) {
    this.createClient =
      deps.createClient ??
      ((baseUrl: string, apiKey?: string, store?: StarciteCliStore) =>
        new Starcite({
          baseUrl,
          apiKey,
          store: store?.sessionStore(toApiBaseUrlForContext(baseUrl)),
        }));
    this.logger = deps.logger ?? defaultLogger;
    this.stdout = deps.stdout ?? defaultStdout;
    this.prompt = deps.prompt ?? createDefaultPrompt();
    this.runCommand = deps.runCommand ?? defaultCommandRunner;
  }

  buildProgram(): Command {
    const createClient = this.createClient;
    const logger = this.logger;
    const stdout = this.stdout;
    const prompt = this.prompt;
    const runCommand = this.runCommand;

    const program = new Command();

    program
      .name("starcite")
      .description("Starcite CLI")
      .showHelpAfterError()
      .version(cliVersion, "-v, --version", "Print current CLI version")
      .option("-u, --base-url <url>", "Starcite API base URL")
      .option("-k, --token <token>", "Starcite API key")
      .option(
        "--config-dir <path>",
        "Starcite CLI config directory (default: ~/.starcite)"
      )
      .option("--json", "Output JSON");

    program
      .command("version")
      .description("Print current CLI version")
      .action(() => {
        logger.info(cliVersion);
      });

    program
      .command("config")
      .description("Manage CLI configuration")
      .addCommand(
        new Command("set")
          .description("Set a configuration value")
          .argument("<key>", "endpoint | api-key")
          .argument("<value>", "value to store")
          .action(async function (this: Command, key: string, value: string) {
            const { store } = await resolveGlobalOptions(this);
            const parsedKey = parseConfigSetKey(key);

            if (parsedKey === "endpoint") {
              const endpoint = parseEndpoint(value, "endpoint");
              await store.updateConfig({ baseUrl: endpoint });
              logger.info(`Endpoint set to ${endpoint}`);
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
          .action(async function (this: Command) {
            const { baseUrl, json, store } = await resolveGlobalOptions(this);
            const config = await store.readConfig();
            const apiKey = await store.readApiKey();
            const fromEnv = trimString(process.env.STARCITE_API_KEY);
            let apiKeySource = "unset";

            if (fromEnv) {
              apiKeySource = "env";
            } else if (apiKey) {
              apiKeySource = "stored";
            }

            const output = {
              endpoint: config.baseUrl ?? baseUrl,
              apiKey: apiKey ? "***" : null,
              apiKeySource,
              configDir: store.directory,
            };

            if (json) {
              writeJsonOutput(stdout, output, true);
              return;
            }

            logger.info(JSON.stringify(output, null, 2));
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
          .action(async function (
            this: Command,
            options: {
              limit?: number;
              cursor?: string;
              metadata?: string;
            }
          ) {
            const resolved = await resolveGlobalOptions(this);
            const { json } = resolved;
            const client = resolved.apiKey
              ? createClient(resolved.baseUrl, resolved.apiKey, resolved.store)
              : createClient(resolved.baseUrl, undefined, resolved.store);

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
              writeJsonOutput(stdout, page, true);
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
      .action(async function (
        this: Command,
        options: {
          yes?: boolean;
          port?: number;
          dbPort?: number;
          image?: string;
        }
      ) {
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
      .action(async function (
        this: Command,
        options: { yes?: boolean; volumes?: boolean }
      ) {
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
      .action(async function (
        this: Command,
        options: {
          id?: string;
          title?: string;
          metadata?: string;
        }
      ) {
        const resolved = await resolveGlobalOptions(this);
        const { json } = resolved;
        const client = resolved.apiKey
          ? createClient(resolved.baseUrl, resolved.apiKey, resolved.store)
          : createClient(resolved.baseUrl, undefined, resolved.store);
        const metadata = options.metadata
          ? parseJsonObject(options.metadata, "--metadata")
          : undefined;
        const session = await client.session({
          identity: resolveCreateIdentity(resolved.apiKey),
          id: options.id,
          title: options.title,
          metadata,
        });

        if (json) {
          writeJsonOutput(stdout, session.record ?? { id: session.id }, true);
          return;
        }

        logger.info(session.id);
      });

    program
      .command("append <sessionId>")
      .description("Append an event")
      .option("--agent <agent>", "Append as agent identity")
      .option("--user <user>", "Append as user identity")
      .option("--text <text>", 'Text content shorthand for {"text": ...}')
      .option("--type <type>", "Event type", "content")
      .option("--source <source>", "Event source")
      .option("--payload <json>", "JSON payload object")
      .option("--metadata <json>", "Event metadata JSON object")
      .option("--refs <json>", "Event refs JSON object")
      .option("--idempotency-key <key>", "Idempotency key")
      .option("--expected-seq <seq>", "Expected sequence", (value) =>
        parseNonNegativeInteger(value, "--expected-seq")
      )
      .action(async function (
        this: Command,
        sessionId: string,
        options: AppendCommandOptions
      ) {
        const { baseUrl, apiKey, json, store } =
          await resolveGlobalOptions(this);
        const client = apiKey
          ? createClient(baseUrl, apiKey, store)
          : createClient(baseUrl, undefined, store);

        const metadata = options.metadata
          ? parseJsonObject(options.metadata, "--metadata")
          : undefined;
        const refs = options.refs
          ? parseJsonObject(options.refs, "--refs")
          : undefined;
        const appendInput = resolveAppendInput(options);
        const session = appendInput.identity
          ? await resolveAppendSession({
              client,
              store,
              baseUrl,
              apiKey,
              sessionId,
              identity: appendInput.identity,
            })
          : await resolveSession(client, apiKey, sessionId);

        const response = await session.append({
          type: options.type,
          payload: appendInput.payload,
          metadata,
          refs,
          source: options.source,
          idempotencyKey: options.idempotencyKey,
          expectedSeq: options.expectedSeq,
        });

        if (json) {
          writeJsonOutput(stdout, response, true);
          return;
        }

        logger.info(`seq=${response.seq} deduped=${response.deduped}`);
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
        const { baseUrl, apiKey, json, store } =
          await resolveGlobalOptions(this);
        const client = apiKey
          ? createClient(baseUrl, apiKey, store)
          : createClient(baseUrl, undefined, store);
        const session = await resolveSession(client, apiKey, sessionId);

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

            if (json) {
              writeJsonOutput(stdout, event);
            } else {
              logger.info(formatTailEvent(event));
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

    return program;
  }

  async run(argv = process.argv): Promise<void> {
    const program = this.buildProgram();

    try {
      await program.parseAsync(argv);
    } catch (error) {
      if (error instanceof StarciteApiError) {
        this.logger.error(`${error.code} (${error.status}): ${error.message}`);
        process.exitCode = 1;
        return;
      }

      if (error instanceof Error) {
        this.logger.error(error.message);
        process.exitCode = 1;
        return;
      }

      this.logger.error("Unknown error");
      process.exitCode = 1;
    }
  }
}

export function buildProgram(deps: CliDependencies = {}): Command {
  return new StarciteCliApp(deps).buildProgram();
}

export async function run(
  argv = process.argv,
  deps: CliDependencies = {}
): Promise<void> {
  await new StarciteCliApp(deps).run(argv);
}
