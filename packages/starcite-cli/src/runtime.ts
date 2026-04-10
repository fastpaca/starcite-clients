import { Starcite, type TailEvent } from "@starcite/sdk";
import arg from "arg";
import {
  resolveConfigDir,
  type StarciteCliConfig,
  StarciteCliConfigStore,
} from "./config";
import { StarciteCliCache } from "./store";

const DEFAULT_API_PORT = 45_187;
const DEFAULT_TAIL_BATCH_SIZE = 256;
const TRAILING_SLASHES_REGEX = /\/+$/;

export { DEFAULT_TAIL_BATCH_SIZE };

export class CliUsageError extends Error {}

export interface LoggerLike {
  info(message: string): void;
  error(message: string): void;
}

export interface StdoutLike {
  write(message: string): void;
}

export interface GlobalOptions {
  baseUrl?: string;
  configDir?: string;
  token?: string;
  json: boolean;
}

export interface CliDependencies {
  createClient?: (
    baseUrl: string,
    apiKey: string | undefined,
    cache: StarciteCliCache
  ) => Starcite;
  logger?: LoggerLike;
  stdout?: StdoutLike;
}

export interface ResolvedGlobalOptions {
  baseUrl: string;
  json: boolean;
  config: StarciteCliConfigStore;
  cache: StarciteCliCache;
  client: Starcite;
}

export type CliJsonObject = Record<string, unknown>;
export type ParsedArgs = ReturnType<typeof arg>;

const defaultLogger: LoggerLike = {
  info(message: string) {
    console.log(message);
  },
  error(message: string) {
    console.error(message);
  },
};

const defaultStdout: StdoutLike = {
  write(message: string) {
    process.stdout.write(message);
  },
};

export function trimString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function parseArgs(
  spec: Parameters<typeof arg>[0],
  argv: string[],
  stopAtPositional = false
): ParsedArgs {
  try {
    return arg(spec, {
      argv,
      permissive: false,
      stopAtPositional,
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new CliUsageError(error.message);
    }

    throw error;
  }
}

export function resolveConfiguredBaseUrl(
  config: StarciteCliConfig,
  options: GlobalOptions
): string {
  return (
    trimString(options.baseUrl) ??
    trimString(process.env.STARCITE_BASE_URL) ??
    trimString(config.baseUrl) ??
    `http://localhost:${DEFAULT_API_PORT}`
  );
}

export function parseNonNegativeInteger(
  value: string,
  optionName: string
): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliUsageError(`${optionName} must be a non-negative integer`);
  }

  return parsed;
}

export function parsePositiveInteger(
  value: string,
  optionName: string
): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${optionName} must be a positive integer`);
  }

  return parsed;
}

export function parseEndpoint(value: string, optionName: string): string {
  const endpoint = trimString(value);
  if (!endpoint) {
    throw new CliUsageError(`${optionName} cannot be empty`);
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new CliUsageError(`${optionName} must be a valid URL`);
  }

  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new CliUsageError(`${optionName} must use http:// or https://`);
  }

  return endpoint.replace(TRAILING_SLASHES_REGEX, "");
}

export function parseConfigSetKey(value: string): "endpoint" | "api-key" {
  const normalized = value.trim().toLowerCase();

  if (normalized === "endpoint" || normalized === "base-url") {
    return "endpoint";
  }

  if (normalized === "api-key") {
    return "api-key";
  }

  throw new CliUsageError("config key must be one of: endpoint, api-key");
}

export function parseJsonObject(
  value: string,
  optionName: string
): CliJsonObject {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CliUsageError(`${optionName} must be valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(`${optionName} must be a JSON object`);
  }

  return parsed as CliJsonObject;
}

export function parseSessionMetadataFilters(
  value: string
): Record<string, string> {
  const filters: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(
    parseJsonObject(value, "--metadata")
  )) {
    if (key.trim().length === 0) {
      throw new CliUsageError("--metadata keys must be non-empty");
    }

    if (typeof rawValue !== "string") {
      throw new CliUsageError("--metadata values must be strings");
    }

    filters[key] = rawValue;
  }

  return filters;
}

export class CliRuntime {
  readonly logger: LoggerLike;
  readonly stdout: StdoutLike;
  private readonly createClient: CliDependencies["createClient"];

  constructor(deps: CliDependencies = {}) {
    this.logger = deps.logger ?? defaultLogger;
    this.stdout = deps.stdout ?? defaultStdout;
    this.createClient = deps.createClient;
  }

  async resolveGlobalOptions(
    options: GlobalOptions
  ): Promise<ResolvedGlobalOptions> {
    const config = new StarciteCliConfigStore(
      resolveConfigDir(options.configDir)
    );
    const cache = new StarciteCliCache(config.directory);
    const baseUrl = resolveConfiguredBaseUrl(
      await config.readConfig(),
      options
    );
    const apiKey = trimString(options.token) ?? (await config.readApiKey());
    const client =
      this.createClient?.(baseUrl, apiKey, cache) ??
      new Starcite({
        baseUrl,
        apiKey,
        cache: cache.sessionCache(baseUrl),
      });

    return {
      baseUrl,
      json: options.json,
      config,
      cache,
      client,
    };
  }

  writeJsonOutput(value: unknown, pretty = false): void {
    const serialized = JSON.stringify(value, null, pretty ? 2 : undefined);
    if (serialized === undefined) {
      throw new Error("Failed to serialize JSON output");
    }

    this.stdout.write(`${serialized}\n`);
  }

  formatTailEvent(event: TailEvent): string {
    const actor = event.actor.startsWith("agent:")
      ? event.actor.slice("agent:".length)
      : event.actor;
    const text = event.payload?.text;

    return typeof text === "string"
      ? `[${actor}] ${text}`
      : `[${actor}] ${JSON.stringify(event.payload)}`;
  }
}
