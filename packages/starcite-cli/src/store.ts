import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import Conf from "conf";
import { cosmiconfig, defaultLoaders } from "cosmiconfig";
import { lock } from "proper-lockfile";
import { parse as parseToml } from "toml";
import { z } from "zod";

const DEFAULT_CONFIG_DIRECTORY_NAME = ".starcite";
const CONFIG_JSON_FILENAME = "config.json";
const CONFIG_TOML_FILENAME = "config.toml";
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
  })
  .passthrough();

const IdentityFileSchema = z.object({
  producerId: z.string().trim().min(1),
  hostname: z.string().trim().min(1),
  uuid: z.string().uuid(),
  createdAt: z.string(),
});

const StateFileSchema = z.object({
  nextSeqByContext: z.record(z.number().int().positive()).default({}),
});

type IdentityFile = z.infer<typeof IdentityFileSchema>;
type StateFile = z.infer<typeof StateFileSchema>;

export interface StarciteCliConfig {
  baseUrl?: string;
  producerId?: string;
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

export class StarciteCliStore {
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
    this.stateStore = new Conf<StateFile>({
      cwd: directory,
      clearInvalidConfig: true,
      configName: STATE_FILENAME,
      fileExtension: "json",
      defaults: { nextSeqByContext: {} },
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

  private readState(): StateFile {
    const parsed = StateFileSchema.safeParse(this.stateStore.store);

    if (parsed.success) {
      return parsed.data;
    }

    this.stateStore.clear();
    return { nextSeqByContext: {} };
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
