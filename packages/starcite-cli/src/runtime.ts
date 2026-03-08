import {
  Starcite,
  StarciteIdentity,
  type StarciteSession,
  type TailEvent,
} from "@starcite/sdk";
import { type Command, InvalidArgumentError } from "commander";
import { createConsola } from "consola";
import { z } from "zod";
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
} from "./up";

export interface GlobalOptions {
  baseUrl?: string;
  configDir?: string;
  token?: string;
  json: boolean;
}

export interface ResolvedGlobalOptions {
  baseUrl: string;
  apiKey?: string;
  json: boolean;
  store: StarciteCliStore;
}

export interface LoggerLike {
  info(message: string): void;
  error(message: string): void;
}

export interface StdoutLike {
  write(message: string): void;
}

export interface CliDependencies {
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

export type CliJsonObject = Record<string, unknown>;
export type ConfigSetKey = "endpoint" | "api-key";

export interface AppendCommandOptions {
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

export interface AppendIdentitySelection {
  type: "agent" | "user";
  id: string;
}

const defaultLogger: LoggerLike = createConsola();
const defaultStdout: StdoutLike = {
  write(message: string) {
    process.stdout.write(message);
  },
};

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
const DEFAULT_CREATE_AGENT_ID = "starcite-cli";

export const DEFAULT_TAIL_BATCH_SIZE = 256;

export function trimString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

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

  if (["api-key", "api_key"].includes(normalized)) {
    return "api-key";
  }

  throw new InvalidArgumentError(
    "config key must be one of: endpoint, api-key"
  );
}

export function parseJsonObject(
  value: string,
  optionName: string
): CliJsonObject {
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

  return trimString(tenantId);
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

function shouldAutoIssueSessionToken(token: string): boolean {
  const scopes = tokenScopes(token);
  return scopes.has("auth:issue");
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

function matchesIdentity(
  identity: StarciteIdentity,
  selection: AppendIdentitySelection
): boolean {
  return identity.type === selection.type && identity.id === selection.id;
}

export class CliRuntime {
  readonly createClient: (
    baseUrl: string,
    apiKey?: string,
    store?: StarciteCliStore
  ) => Starcite;
  readonly logger: LoggerLike;
  readonly stdout: StdoutLike;
  readonly prompt: PromptAdapter;
  readonly runCommand: CommandRunner;

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

  async resolveGlobalOptions(command: Command): Promise<ResolvedGlobalOptions> {
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

  createSdkClient(resolved: ResolvedGlobalOptions): Starcite {
    return this.createClient(resolved.baseUrl, resolved.apiKey, resolved.store);
  }

  writeJsonOutput(value: unknown, pretty = false): void {
    const serialized = JSON.stringify(value, null, pretty ? 2 : undefined);
    if (serialized === undefined) {
      throw new Error("Failed to serialize JSON output");
    }

    this.stdout.write(`${serialized}\n`);
  }

  formatTailEvent(event: TailEvent): string {
    const actorLabel = event.actor.startsWith("agent:")
      ? event.actor.slice("agent:".length)
      : event.actor;
    const maybeText = event.payload?.text;

    if (typeof maybeText === "string") {
      return `[${actorLabel}] ${maybeText}`;
    }

    return `[${actorLabel}] ${JSON.stringify(event.payload)}`;
  }

  resolveCreateIdentity(
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

  resolveAppendIdentity(
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

  async resolveSession(
    client: Starcite,
    apiKey: string | undefined,
    sessionId: string
  ): Promise<StarciteSession> {
    if (!apiKey) {
      throw new InvalidArgumentError(
        "append/tail require --token or a saved API key"
      );
    }

    if (shouldAutoIssueSessionToken(apiKey)) {
      return await client.session({
        identity: this.resolveCreateIdentity(apiKey),
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

  async resolveAppendSession(input: {
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
      const session = await this.resolveSession(client, apiKey, sessionId);
      if (!matchesIdentity(session.identity, identity)) {
        throw new InvalidArgumentError(
          `session token is bound to ${session.identity.type} '${session.identity.id}', expected ${identity.type} '${identity.id}'`
        );
      }
      return session;
    }

    const contextKey = buildSessionTokenContextKey(
      baseUrl,
      sessionId,
      identity
    );
    const cachedToken = await store.readSessionToken(contextKey);

    if (cachedToken) {
      try {
        const cachedSession = client.session({ token: cachedToken });
        if (
          cachedSession.id === sessionId &&
          matchesIdentity(cachedSession.identity, identity)
        ) {
          return cachedSession;
        }
      } catch {
        // Fall through to re-issuing a fresh token below.
      }

      await store.clearSessionToken(contextKey);
    }

    const session = await client.session({
      identity: this.resolveAppendIdentity(apiKey, identity),
      id: sessionId,
    });
    await store.saveSessionToken(contextKey, session.token);
    return session;
  }
}
