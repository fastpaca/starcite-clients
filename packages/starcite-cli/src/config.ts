import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Conf from "conf";
import { parse as parseToml } from "toml";
import { z } from "zod";
import { trimString } from "./runtime";

const DEFAULT_CONFIG_DIRECTORY_NAME = ".starcite";
const CONFIG_JSON_FILENAME = "config.json";
const CONFIG_TOML_FILENAME = "config.toml";
const CREDENTIALS_FILENAME = "credentials";
const TILDE_PREFIX_REGEX = /^~(?=\/|$)/;

const ConfigFileSchema = z
  .object({
    baseUrl: z.string().optional(),
    base_url: z.string().optional(),
    apiKey: z.string().optional(),
    api_key: z.string().optional(),
  })
  .passthrough();

const CredentialsFileSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
});

type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

export interface StarciteCliConfig {
  baseUrl?: string;
  apiKey?: string;
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
  return home.trim().length > 0
    ? join(home, DEFAULT_CONFIG_DIRECTORY_NAME)
    : resolve(DEFAULT_CONFIG_DIRECTORY_NAME);
}

export function resolveConfigDir(input?: string): string {
  const configured = trimString(input) ?? trimString(process.env.STARCITE_HOME);
  const withTilde = configured?.startsWith("~")
    ? configured.replace(TILDE_PREFIX_REGEX, homedir())
    : configured;

  return resolve(withTilde ?? defaultConfigDirectory());
}

export class StarciteCliConfigStore {
  readonly directory: string;
  private readonly credentialsStore: Conf<CredentialsFile>;

  constructor(directory: string) {
    this.directory = directory;
    this.credentialsStore = new Conf<CredentialsFile>({
      cwd: directory,
      clearInvalidConfig: true,
      configName: CREDENTIALS_FILENAME,
      fileExtension: "json",
    });
  }

  async readConfig(): Promise<StarciteCliConfig> {
    await this.ensureDirectory();

    for (const filename of [CONFIG_JSON_FILENAME, CONFIG_TOML_FILENAME]) {
      const parsed = await this.readConfigFile(filename);
      if (parsed !== undefined) {
        return normalizeConfig(parsed);
      }
    }

    return {};
  }

  async writeConfig(config: StarciteCliConfig): Promise<void> {
    await this.ensureDirectory();

    const normalized = normalizeConfig(config);
    await writeFile(
      join(this.directory, CONFIG_JSON_FILENAME),
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8"
    );
  }

  async updateConfig(
    patch: Partial<StarciteCliConfig>
  ): Promise<StarciteCliConfig> {
    const config = normalizeConfig({
      ...(await this.readConfig()),
      ...patch,
    });

    await this.writeConfig(config);
    return config;
  }

  async readApiKey(): Promise<string | undefined> {
    const fromCredentials = trimString(this.readCredentials().apiKey);
    if (fromCredentials) {
      return fromCredentials;
    }

    return trimString((await this.readConfig()).apiKey);
  }

  async saveApiKey(apiKey: string): Promise<void> {
    await this.ensureDirectory();

    const normalized = trimString(apiKey);
    if (!normalized) {
      throw new Error("API key cannot be empty");
    }

    this.credentialsStore.set("apiKey", normalized);
  }

  private async readConfigFile(filename: string): Promise<unknown | undefined> {
    const path = join(this.directory, filename);

    try {
      const content = await readFile(path, "utf8");
      return filename.endsWith(".toml")
        ? parseToml(content)
        : JSON.parse(content);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }

      throw error;
    }
  }

  private readCredentials(): CredentialsFile {
    const parsed = CredentialsFileSchema.safeParse(this.credentialsStore.store);

    if (parsed.success) {
      return parsed.data;
    }

    this.credentialsStore.clear();
    return {};
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }
}
