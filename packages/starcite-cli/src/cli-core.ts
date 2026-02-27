import type {
  SessionEvent,
  SessionTokenScope,
  StarciteClient,
} from "@starcite/sdk";
import { type Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import type {
  AppendCommandOptions,
  CliJsonObject,
  GlobalOptions,
  ResolvedAppendMode,
  ResolvedGlobalOptions,
} from "./cli-types";
import {
  resolveConfigDir,
  type StarciteCliConfig,
  StarciteCliStore,
} from "./store";
import { DEFAULT_API_PORT, type PromptAdapter, parsePortOption } from "./up";

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

export const DEFAULT_TAIL_BATCH_SIZE = 256;
const CLI_SESSION_TOKEN_PRINCIPAL_ID = "starcite-cli";

type ConfigSetKey = "endpoint" | "producer-id" | "api-key";

export function parseNonNegativeInteger(
  value: string,
  optionName: string
): number {
  const parsed = nonNegativeIntegerSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidArgumentError(
      `${optionName} must be a non-negative integer`
    );
  }

  return parsed.data;
}

export function parsePositiveInteger(
  value: string,
  optionName: string
): number {
  const parsed = positiveIntegerSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidArgumentError(`${optionName} must be a positive integer`);
  }

  return parsed.data;
}

export function parsePort(value: string, optionName: string): number {
  return parsePortOption(value, optionName);
}

export function parseEndpoint(value: string, optionName: string): string {
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

export function parseConfigSetKey(value: string): ConfigSetKey {
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

export function parseJsonObject(
  value: string,
  optionName: string
): CliJsonObject {
  return parseJsonOption(value, jsonObjectSchema, optionName, "a JSON object");
}

export function parseEventRefs(value: string): CliJsonObject {
  return parseJsonObject(value, "--refs");
}

export function parseSessionMetadataFilters(
  value: string
): Record<string, string> {
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

export function trimString(value?: string): string | undefined {
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

export function withResolvedGlobals<TArgs extends unknown[]>(
  action: (
    globals: ResolvedGlobalOptions,
    ...args: TArgs
  ) => Promise<void> | void
): (...args: TArgs) => Promise<void> {
  return async function withGlobalOptions(
    this: Command,
    ...args: TArgs
  ): Promise<void> {
    const globals = await resolveGlobalOptions(this);
    await action(globals, ...args);
  };
}

export async function promptForEndpoint(
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

export async function promptForApiKey(prompt: PromptAdapter): Promise<string> {
  const message = "Paste your Starcite API key";
  const answer = prompt.password
    ? await prompt.password(message)
    : await prompt.input(message, "");

  return trimString(answer) ?? "";
}

export function formatTailEvent(event: SessionEvent): string {
  const actorLabel = event.agent ?? event.actor;

  if (event.text) {
    return `[${actorLabel}] ${event.text}`;
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

export function createClientForGlobals(
  createClient: (baseUrl: string, apiKey?: string) => StarciteClient,
  options: Pick<ResolvedGlobalOptions, "baseUrl" | "apiKey">
): StarciteClient {
  return options.apiKey
    ? createClient(options.baseUrl, options.apiKey)
    : createClient(options.baseUrl);
}

export function resolveAppendMode(
  options: AppendCommandOptions
): ResolvedAppendMode {
  const highLevelMode =
    options.agent !== undefined || options.text !== undefined;
  const rawMode = options.actor !== undefined || options.payload !== undefined;

  if (highLevelMode && rawMode) {
    throw new InvalidArgumentError(
      "Choose either high-level mode (--agent and --text) or raw mode (--actor and --payload), not both"
    );
  }

  if (highLevelMode) {
    const agent = trimString(options.agent);
    const text = trimString(options.text);
    if (!(agent && text)) {
      throw new InvalidArgumentError(
        "--agent and --text are required for high-level append mode"
      );
    }

    return { kind: "high-level", agent, text };
  }

  if (rawMode) {
    const actor = trimString(options.actor);
    const payload = trimString(options.payload);
    if (!(actor && payload)) {
      throw new InvalidArgumentError(
        "Raw append mode requires --actor and --payload, or use --agent and --text"
      );
    }

    return { kind: "raw", actor, payload };
  }

  throw new InvalidArgumentError(
    "append requires either high-level mode (--agent and --text) or raw mode (--actor and --payload)"
  );
}

export async function resolveSessionClient(
  createClient: (baseUrl: string, apiKey?: string) => StarciteClient,
  baseUrl: string,
  apiKey: string | undefined,
  sessionId: string,
  scopes: SessionTokenScope[]
): Promise<StarciteClient> {
  if (!apiKey) {
    return createClient(baseUrl);
  }

  if (!shouldAutoIssueSessionToken(apiKey)) {
    return createClient(baseUrl, apiKey);
  }

  const issuerClient = createClient(baseUrl, apiKey);
  const issued = await issuerClient.issueSessionToken({
    session_id: sessionId,
    principal: {
      type: "agent",
      id: CLI_SESSION_TOKEN_PRINCIPAL_ID,
    },
    scopes,
  });

  return createClient(baseUrl, issued.token);
}

export function appendHighLevel(
  session: ReturnType<StarciteClient["session"]>,
  options: {
    agent: string;
    text: string;
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

export function appendRaw(
  session: ReturnType<StarciteClient["session"]>,
  options: {
    actor: string;
    payload: string;
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
