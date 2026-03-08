import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import type { SessionStore, SessionStoreState, TailEvent } from "@starcite/sdk";
import Conf from "conf";
import { cosmiconfig, defaultLoaders } from "cosmiconfig";
import { lock } from "proper-lockfile";
import { parse as parseToml } from "toml";
import { z } from "zod";

const DEFAULT_CONFIG_DIRECTORY_NAME = ".starcite";
const CONFIG_JSON_FILENAME = "config.json";
const CONFIG_TOML_FILENAME = "config.toml";
const CREDENTIALS_FILENAME = "credentials";
const IDENTITY_FILENAME = "identity";
const STATE_FILENAME = "state";
const STATE_LOCK_FILENAME = ".state.lock";
const TILDE_PREFIX_REGEX = /^~(?=\/|$)/;

const ConfigFileSchema = z
  .object({
    baseUrl: z.string().optional(),
    base_url: z.string().optional(),
    producerId: z.string().optional(),
    producer_id: z.string().optional(),
    apiKey: z.string().optional(),
    api_key: z.string().optional(),
  })
  .passthrough();

const IdentityFileSchema = z.object({
  producerId: z.string().trim().min(1),
  hostname: z.string().trim().min(1),
  uuid: z.string().uuid(),
  createdAt: z.string(),
});

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
});

const StateFileSchema = z.object({
  nextSeqByContext: z.record(z.number().int().positive()).default({}),
  sessionStateBySessionId: z.record(StoredSessionStoreStateSchema).default({}),
});

const CredentialsFileSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  sessionTokensByContext: z.record(z.string().trim().min(1)).default({}),
});

type IdentityFile = z.infer<typeof IdentityFileSchema>;
type StateFile = z.infer<typeof StateFileSchema>;
type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

export interface StarciteCliConfig {
  baseUrl?: string;
  producerId?: string;
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
    producerId: trimString(parsed.data.producerId ?? parsed.data.producer_id),
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

export function buildSeqContextKey(
  baseUrl: string,
  sessionId: string,
  producerId: string
): string {
  return `${baseUrl}::${sessionId}::${producerId}`;
}

export class StarciteCliStore implements SessionStore<TailEvent> {
  readonly directory: string;
  private readonly lockPath: string;
  private readonly configExplorer = cosmiconfig("starcite", {
    cache: false,
    searchStrategy: "none",
    searchPlaces: [CONFIG_JSON_FILENAME, CONFIG_TOML_FILENAME],
    loaders: {
      ...defaultLoaders,
      ".toml": (_filepath, content) => parseToml(content) as unknown,
    },
  });
  private readonly identityStore: Conf<IdentityFile>;
  private readonly credentialsStore: Conf<CredentialsFile>;
  private readonly stateStore: Conf<StateFile>;

  constructor(directory: string) {
    this.directory = directory;
    this.lockPath = join(directory, STATE_LOCK_FILENAME);
    this.identityStore = new Conf<IdentityFile>({
      cwd: directory,
      clearInvalidConfig: true,
      configName: IDENTITY_FILENAME,
      fileExtension: "json",
    });
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
      defaults: { nextSeqByContext: {}, sessionStateBySessionId: {} },
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

    if (normalized.producerId) {
      serialized.producerId = normalized.producerId;
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

  async resolveProducerId(explicitProducerId?: string): Promise<string> {
    const explicit = trimString(explicitProducerId);
    if (explicit) {
      return explicit;
    }

    const fromEnv = trimString(process.env.STARCITE_PRODUCER_ID);
    if (fromEnv) {
      return fromEnv;
    }

    const config = await this.readConfig();
    const fromConfig = trimString(config.producerId);
    if (fromConfig) {
      return fromConfig;
    }

    const identity = await this.readOrCreateIdentity();
    return identity.producerId;
  }

  async withStateLock<T>(action: () => Promise<T>): Promise<T> {
    await this.ensureConfigDirectory();
    const release = await lock(this.directory, {
      lockfilePath: this.lockPath,
      realpath: false,
      retries: {
        retries: 50,
        minTimeout: 20,
        maxTimeout: 60,
      },
    });

    try {
      return await action();
    } finally {
      await release();
    }
  }

  readNextSeq(contextKey: string): Promise<number> {
    const state = this.readState();
    return Promise.resolve(state.nextSeqByContext[contextKey] ?? 1);
  }

  bumpNextSeq(contextKey: string, usedSeq: number): Promise<void> {
    const state = this.readState();
    const nextSeqByContext = {
      ...state.nextSeqByContext,
      [contextKey]: Math.max(
        state.nextSeqByContext[contextKey] ?? 1,
        usedSeq + 1
      ),
    };

    this.stateStore.set("nextSeqByContext", nextSeqByContext);
    return Promise.resolve();
  }

  load(sessionId: string): SessionStoreState<TailEvent> | undefined {
    const state = this.readState();
    const storedState = state.sessionStateBySessionId[sessionId];
    return storedState ? structuredClone(storedState) : undefined;
  }

  save(sessionId: string, sessionState: SessionStoreState<TailEvent>): void {
    const state = this.readState();
    this.stateStore.set("sessionStateBySessionId", {
      ...state.sessionStateBySessionId,
      [sessionId]: structuredClone(sessionState),
    });
  }

  clear(sessionId: string): void {
    const state = this.readState();
    if (!(sessionId in state.sessionStateBySessionId)) {
      return;
    }

    const sessionStateBySessionId = { ...state.sessionStateBySessionId };
    Reflect.deleteProperty(sessionStateBySessionId, sessionId);
    this.stateStore.set("sessionStateBySessionId", sessionStateBySessionId);
  }

  private readState(): StateFile {
    const parsed = StateFileSchema.safeParse(this.stateStore.store);

    if (parsed.success) {
      return parsed.data;
    }

    this.stateStore.clear();
    return { nextSeqByContext: {}, sessionStateBySessionId: {} };
  }

  private readCredentials(): CredentialsFile {
    const parsed = CredentialsFileSchema.safeParse(this.credentialsStore.store);

    if (parsed.success) {
      return parsed.data;
    }

    this.credentialsStore.clear();
    return { sessionTokensByContext: {} };
  }

  private readOrCreateIdentity(): IdentityFile {
    const parsed = IdentityFileSchema.safeParse(this.identityStore.store);
    if (parsed.success) {
      return parsed.data;
    }

    const host = hostname();
    const uuid = randomUUID();
    const identity: IdentityFile = {
      producerId: `cli:${host}:${uuid}`,
      hostname: host,
      uuid,
      createdAt: new Date().toISOString(),
    };

    this.identityStore.store = identity;
    return identity;
  }

  private async ensureConfigDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }
}
