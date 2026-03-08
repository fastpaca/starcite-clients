import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionStore, SessionStoreState, TailEvent } from "@starcite/sdk";
import Conf from "conf";
import { cosmiconfig, defaultLoaders } from "cosmiconfig";
import { parse as parseToml } from "toml";
import { z } from "zod";

const DEFAULT_CONFIG_DIRECTORY_NAME = ".starcite";
const CONFIG_JSON_FILENAME = "config.json";
const CONFIG_TOML_FILENAME = "config.toml";
const CREDENTIALS_FILENAME = "credentials";
const STATE_FILENAME = "state";
const TILDE_PREFIX_REGEX = /^~(?=\/|$)/;

const ConfigFileSchema = z
  .object({
    baseUrl: z.string().optional(),
    base_url: z.string().optional(),
    apiKey: z.string().optional(),
    api_key: z.string().optional(),
  })
  .passthrough();

const StoredTailEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  payload: z.record(z.unknown()),
  actor: z.string().min(1),
  producer_id: z.string().min(1),
  producer_seq: z.number().int().positive(),
  source: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  refs: z.record(z.unknown()).optional(),
  idempotency_key: z.string().nullable().optional(),
  inserted_at: z.string().optional(),
});

const StoredSessionStoreStateSchema = z.object({
  cursor: z.number().int().nonnegative(),
  events: z.array(StoredTailEventSchema),
  producer: z
    .object({
      id: z.string().trim().min(1),
      seq: z.number().int().nonnegative(),
    })
    .optional(),
  metadata: z
    .object({
      schemaVersion: z.union([z.literal(1), z.literal(2)]),
      updatedAtMs: z.number().int().nonnegative(),
    })
    .optional(),
  producersById: z
    .record(
      z.object({
        id: z.string().trim().min(1),
        seq: z.number().int().nonnegative(),
      })
    )
    .optional(),
});

const StateFileSchema = z.object({
  sessionStateByContext: z.record(StoredSessionStoreStateSchema).default({}),
});

const CredentialsFileSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  sessionTokensByContext: z.record(z.string().trim().min(1)).default({}),
});

type StateFile = z.infer<typeof StateFileSchema>;
type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

export interface StarciteCliConfig {
  baseUrl?: string;
  apiKey?: string;
}

function trimString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeConfig(input: unknown): StarciteCliConfig {
  const parsed = ConfigFileSchema.safeParse(input);

  if (!parsed.success) {
    return {};
  }

  return {
    baseUrl: trimString(parsed.data.baseUrl ?? parsed.data.base_url),
    apiKey: trimString(parsed.data.apiKey ?? parsed.data.api_key),
  };
}

function defaultConfigDirectory(): string {
  const home = homedir();
  if (home.trim().length > 0) {
    return join(home, DEFAULT_CONFIG_DIRECTORY_NAME);
  }

  return resolve(DEFAULT_CONFIG_DIRECTORY_NAME);
}

export function resolveConfigDir(input?: string): string {
  const configured = trimString(input) ?? trimString(process.env.STARCITE_HOME);
  const withTilde = configured?.startsWith("~")
    ? configured.replace(TILDE_PREFIX_REGEX, homedir())
    : configured;

  return resolve(withTilde ?? defaultConfigDirectory());
}

export function buildSessionStoreContextKey(
  baseUrl: string,
  sessionId: string
): string {
  return `${baseUrl}::${sessionId}`;
}

export class StarciteCliStore implements SessionStore<TailEvent> {
  readonly directory: string;
  private readonly configExplorer = cosmiconfig("starcite", {
    cache: false,
    searchStrategy: "none",
    searchPlaces: [CONFIG_JSON_FILENAME, CONFIG_TOML_FILENAME],
    loaders: {
      ...defaultLoaders,
      ".toml": (_filepath, content) => parseToml(content) as unknown,
    },
  });
  private readonly credentialsStore: Conf<CredentialsFile>;
  private readonly stateStore: Conf<StateFile>;

  constructor(directory: string) {
    this.directory = directory;
    this.credentialsStore = new Conf<CredentialsFile>({
      cwd: directory,
      clearInvalidConfig: true,
      configName: CREDENTIALS_FILENAME,
      fileExtension: "json",
      defaults: { sessionTokensByContext: {} },
    });
    this.stateStore = new Conf<StateFile>({
      cwd: directory,
      clearInvalidConfig: true,
      configName: STATE_FILENAME,
      fileExtension: "json",
      defaults: { sessionStateByContext: {} },
    });
  }

  async readConfig(): Promise<StarciteCliConfig> {
    await this.ensureConfigDirectory();
    const result = await this.configExplorer.search(this.directory);

    if (!result) {
      return {};
    }

    return normalizeConfig(result.config);
  }

  async writeConfig(config: StarciteCliConfig): Promise<void> {
    await this.ensureConfigDirectory();

    const normalized = normalizeConfig(config);
    const serialized: StarciteCliConfig = {};

    if (normalized.baseUrl) {
      serialized.baseUrl = normalized.baseUrl;
    }

    if (normalized.apiKey) {
      serialized.apiKey = normalized.apiKey;
    }

    await writeFile(
      join(this.directory, CONFIG_JSON_FILENAME),
      `${JSON.stringify(serialized, null, 2)}\n`,
      "utf8"
    );
  }

  async updateConfig(
    patch: Partial<StarciteCliConfig>
  ): Promise<StarciteCliConfig> {
    const current = await this.readConfig();
    const merged = normalizeConfig({
      ...current,
      ...patch,
    });

    await this.writeConfig(merged);
    return merged;
  }

  async readApiKey(): Promise<string | undefined> {
    const fromEnv = trimString(process.env.STARCITE_API_KEY);
    if (fromEnv) {
      return fromEnv;
    }

    const fromCredentials = trimString(this.readCredentials().apiKey);
    if (fromCredentials) {
      return fromCredentials;
    }

    const config = await this.readConfig();
    return trimString(config.apiKey);
  }

  async saveApiKey(apiKey: string): Promise<void> {
    await this.ensureConfigDirectory();

    const normalized = trimString(apiKey);
    if (!normalized) {
      throw new Error("API key cannot be empty");
    }

    this.credentialsStore.set("apiKey", normalized);
  }

  async clearApiKey(): Promise<void> {
    await this.ensureConfigDirectory();
    this.credentialsStore.delete("apiKey");
  }

  readSessionToken(contextKey: string): Promise<string | undefined> {
    const credentials = this.readCredentials();
    return Promise.resolve(
      trimString(credentials.sessionTokensByContext[contextKey])
    );
  }

  async saveSessionToken(contextKey: string, token: string): Promise<void> {
    await this.ensureConfigDirectory();

    const normalized = trimString(token);
    if (!normalized) {
      throw new Error("Session token cannot be empty");
    }

    const credentials = this.readCredentials();
    this.credentialsStore.set("sessionTokensByContext", {
      ...credentials.sessionTokensByContext,
      [contextKey]: normalized,
    });
  }

  async clearSessionToken(contextKey: string): Promise<void> {
    await this.ensureConfigDirectory();

    const credentials = this.readCredentials();
    if (!(contextKey in credentials.sessionTokensByContext)) {
      return;
    }

    const sessionTokensByContext = { ...credentials.sessionTokensByContext };
    Reflect.deleteProperty(sessionTokensByContext, contextKey);
    this.credentialsStore.set("sessionTokensByContext", sessionTokensByContext);
  }

  sessionStore(baseUrl: string): SessionStore<TailEvent> {
    return {
      load: (sessionId) => this.loadScopedState(baseUrl, sessionId),
      save: (sessionId, sessionState) =>
        this.saveScopedState(baseUrl, sessionId, sessionState),
      clear: (sessionId) => this.clearScopedState(baseUrl, sessionId),
    };
  }

  load(sessionId: string): SessionStoreState<TailEvent> | undefined {
    return this.loadScopedState("", sessionId);
  }

  save(sessionId: string, sessionState: SessionStoreState<TailEvent>): void {
    this.saveScopedState("", sessionId, sessionState);
  }

  clear(sessionId: string): void {
    this.clearScopedState("", sessionId);
  }

  private loadScopedState(
    baseUrl: string,
    sessionId: string
  ): SessionStoreState<TailEvent> | undefined {
    const state = this.readState();
    const contextKey = buildSessionStoreContextKey(baseUrl, sessionId);
    const storedState = state.sessionStateByContext[contextKey];
    return storedState ? structuredClone(storedState) : undefined;
  }

  private saveScopedState(
    baseUrl: string,
    sessionId: string,
    sessionState: SessionStoreState<TailEvent>
  ): void {
    const state = this.readState();
    const contextKey = buildSessionStoreContextKey(baseUrl, sessionId);
    const existingState = state.sessionStateByContext[contextKey];

    this.stateStore.set("sessionStateByContext", {
      ...state.sessionStateByContext,
      [contextKey]: {
        ...structuredClone(sessionState),
        producersById:
          sessionState.producersById ?? existingState?.producersById,
      },
    });
  }

  private clearScopedState(baseUrl: string, sessionId: string): void {
    const state = this.readState();
    const contextKey = buildSessionStoreContextKey(baseUrl, sessionId);
    if (!(contextKey in state.sessionStateByContext)) {
      return;
    }

    const sessionStateByContext = { ...state.sessionStateByContext };
    Reflect.deleteProperty(sessionStateByContext, contextKey);
    this.stateStore.set("sessionStateByContext", sessionStateByContext);
  }

  private readState(): StateFile {
    const parsed = StateFileSchema.safeParse(this.stateStore.store);

    if (parsed.success) {
      return parsed.data;
    }

    this.stateStore.clear();
    return { sessionStateByContext: {} };
  }

  private readCredentials(): CredentialsFile {
    const parsed = CredentialsFileSchema.safeParse(this.credentialsStore.store);

    if (parsed.success) {
      return parsed.data;
    }

    this.credentialsStore.clear();
    return { sessionTokensByContext: {} };
  }

  private async ensureConfigDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }
}
