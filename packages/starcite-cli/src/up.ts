import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cancel as clackCancel,
  confirm as clackConfirm,
  password as clackPassword,
  text as clackText,
  isCancel,
} from "@clack/prompts";
import type { LoggerLike } from "./cli";
import type { StarciteCliStore } from "./store";

export const DEFAULT_API_PORT = 45_187;
const DEFAULT_DB_PORT = 5433;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
const RUNTIME_DIRECTORY_NAME = "runtime";

const DEFAULT_COMPOSE_FILE = `services:
  app:
    image: \${STARCITE_IMAGE:-ghcr.io/fastpaca/starcite:latest}
    depends_on:
      db:
        condition: service_healthy
    environment:
      SECRET_KEY_BASE: \${SECRET_KEY_BASE:-xuQnOFm6sH5Qdd7x4WJv5smuG2Xf2nG0BL8rJ4yX6HnKGeTjo6n8r5hQKsxNkZWz}
      PHX_HOST: \${PHX_HOST:-localhost}
      PORT: 4000
      DATABASE_URL: \${DATABASE_URL:-ecto://postgres:postgres@db:5432/starcite_dev}
      MIGRATE_ON_BOOT: \${MIGRATE_ON_BOOT:-true}
      DNS_CLUSTER_QUERY: \${DNS_CLUSTER_QUERY:-}
      DNS_CLUSTER_NODE_BASENAME: \${DNS_CLUSTER_NODE_BASENAME:-starcite}
      DNS_POLL_INTERVAL_MS: \${DNS_POLL_INTERVAL_MS:-5000}
    ports:
      - "\${STARCITE_API_PORT:-45187}:4000"
    restart: unless-stopped

  db:
    image: postgres:15
    environment:
      POSTGRES_DB: starcite_dev
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
    ports:
      - "\${STARCITE_DB_PORT:-5433}:5432"
    volumes:
      - db-data:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  db-data:
`;

interface CommandRunOptions {
  cwd?: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandRunOptions
) => Promise<CommandResult>;

export interface PromptAdapter {
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  input(message: string, defaultValue?: string): Promise<string>;
  password?(message: string): Promise<string>;
}

export interface UpOptions {
  yes?: boolean;
  port?: number;
  dbPort?: number;
  image?: string;
}

export interface DownOptions {
  yes?: boolean;
  volumes?: boolean;
}

interface UpWizardInput {
  baseUrl: string;
  logger: LoggerLike;
  options: UpOptions;
  prompt: PromptAdapter;
  runCommand: CommandRunner;
  store: StarciteCliStore;
}

interface DownWizardInput {
  logger: LoggerLike;
  options: DownOptions;
  prompt: PromptAdapter;
  runCommand: CommandRunner;
  store: StarciteCliStore;
}

function parsePort(value: string, optionName: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(
      `${optionName} must be an integer between ${MIN_PORT} and ${MAX_PORT}`
    );
  }

  return parsed;
}

function baseUrlPort(baseUrl: string): number {
  try {
    const parsed = new URL(baseUrl);

    if (parsed.port) {
      return parsePort(parsed.port, "base URL port");
    }
  } catch {
    return DEFAULT_API_PORT;
  }

  return DEFAULT_API_PORT;
}

async function ensureSuccess(
  runCommand: CommandRunner,
  command: string,
  args: string[]
): Promise<boolean> {
  const result = await runCommand(command, args);
  return result.code === 0;
}

async function ensureDockerReady(
  logger: LoggerLike,
  runCommand: CommandRunner
): Promise<void> {
  const hasDocker = await ensureSuccess(runCommand, "docker", ["--version"]);
  if (!hasDocker) {
    logger.error("You don't have Docker installed, please install it.");
    throw new Error("Docker is required to run this command.");
  }

  const hasDockerCompose = await ensureSuccess(runCommand, "docker", [
    "compose",
    "version",
  ]);
  if (!hasDockerCompose) {
    logger.error(
      "Docker Compose is not available. Install Docker Compose and retry."
    );
    throw new Error("Docker Compose is required to run this command.");
  }

  const daemonRunning = await ensureSuccess(runCommand, "docker", ["info"]);
  if (!daemonRunning) {
    logger.error("Docker is installed but the daemon is not running.");
    throw new Error("Start Docker and retry.");
  }
}

async function selectApiPort(
  baseUrl: string,
  options: UpOptions,
  prompt: PromptAdapter
): Promise<number> {
  if (options.port !== undefined) {
    return options.port;
  }

  const fallbackPort = baseUrlPort(baseUrl);

  if (options.yes) {
    return fallbackPort;
  }

  while (true) {
    const answer = await prompt.input(
      "What port do you want it on?",
      `${fallbackPort}`
    );

    try {
      return parsePort(answer, "port");
    } catch (error) {
      if (error instanceof Error) {
        // keep asking until valid
      }
    }
  }
}

function runtimeDirectory(store: StarciteCliStore): string {
  return join(store.directory, RUNTIME_DIRECTORY_NAME);
}

async function runtimeDirectoryExists(
  store: StarciteCliStore
): Promise<boolean> {
  try {
    const result = await stat(runtimeDirectory(store));
    return result.isDirectory();
  } catch {
    return false;
  }
}

async function writeComposeFiles(
  store: StarciteCliStore,
  options: { apiPort: number; dbPort: number; image?: string }
): Promise<string> {
  const directory = runtimeDirectory(store);
  await mkdir(directory, { recursive: true });

  await writeFile(
    join(directory, "docker-compose.yml"),
    DEFAULT_COMPOSE_FILE,
    "utf8"
  );

  const envLines = [
    `STARCITE_API_PORT=${options.apiPort}`,
    `STARCITE_DB_PORT=${options.dbPort}`,
  ];

  if (options.image?.trim()) {
    envLines.push(`STARCITE_IMAGE=${options.image.trim()}`);
  }

  await writeFile(join(directory, ".env"), `${envLines.join("\n")}\n`, "utf8");
  return directory;
}

export function parsePortOption(value: string, optionName: string): number {
  try {
    return parsePort(value, optionName);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(error.message);
    }

    throw error;
  }
}

export async function runUpWizard(input: UpWizardInput): Promise<void> {
  const { baseUrl, logger, options, prompt, runCommand, store } = input;

  await ensureDockerReady(logger, runCommand);

  const confirmed = options.yes
    ? true
    : await prompt.confirm(
        "Are you sure you want to create the docker containers?",
        true
      );

  if (!confirmed) {
    logger.info("Cancelled.");
    return;
  }

  const apiPort = await selectApiPort(baseUrl, options, prompt);
  const dbPort = options.dbPort ?? DEFAULT_DB_PORT;
  const composeDirectory = await writeComposeFiles(store, {
    apiPort,
    dbPort,
    image: options.image,
  });

  const result = await runCommand("docker", ["compose", "up", "-d"], {
    cwd: composeDirectory,
  });

  if (result.code !== 0) {
    const message =
      result.stderr || result.stdout || "docker compose up failed";
    throw new Error(message.trim());
  }

  logger.info(`Starcite is starting on http://localhost:${apiPort}`);
  logger.info(`Compose files are in ${composeDirectory}`);
}

export async function runDownWizard(input: DownWizardInput): Promise<void> {
  const { logger, options, prompt, runCommand, store } = input;

  await ensureDockerReady(logger, runCommand);

  const hasRuntimeDirectory = await runtimeDirectoryExists(store);
  if (!hasRuntimeDirectory) {
    logger.info(
      `No Starcite runtime found at ${runtimeDirectory(
        store
      )}. Nothing to tear down.`
    );
    return;
  }

  const removeVolumes = options.volumes ?? true;
  const confirmed = options.yes
    ? true
    : await prompt.confirm(
        removeVolumes
          ? "Are you sure you want to stop and delete Starcite containers and volumes?"
          : "Are you sure you want to stop Starcite containers?",
        false
      );

  if (!confirmed) {
    logger.info("Cancelled.");
    return;
  }

  const args = ["compose", "down", "--remove-orphans"];
  if (removeVolumes) {
    args.push("-v");
  }

  const result = await runCommand("docker", args, {
    cwd: runtimeDirectory(store),
  });

  if (result.code !== 0) {
    const message =
      result.stderr || result.stdout || "docker compose down failed";
    throw new Error(message.trim());
  }

  logger.info("Starcite containers stopped.");
  if (removeVolumes) {
    logger.info("Starcite volumes removed.");
  }
}

export function createDefaultPrompt(): PromptAdapter {
  const assertInteractive = (): void => {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      throw new Error(
        "Interactive mode requires a TTY. Re-run with explicit options (for example: --yes, --endpoint, --api-key)."
      );
    }
  };

  return {
    async confirm(message: string, defaultValue = true): Promise<boolean> {
      assertInteractive();

      const answer = await clackConfirm({
        message,
        initialValue: defaultValue,
        input: process.stdin,
        output: process.stdout,
      });

      if (isCancel(answer)) {
        clackCancel("Cancelled.");
        return false;
      }

      return answer;
    },
    async input(message: string, defaultValue = ""): Promise<string> {
      assertInteractive();

      const answer = await clackText({
        message,
        defaultValue,
        placeholder: defaultValue || undefined,
        input: process.stdin,
        output: process.stdout,
      });

      if (isCancel(answer)) {
        clackCancel("Cancelled.");
        throw new Error("Cancelled.");
      }

      const normalized = answer.trim();
      return normalized || defaultValue;
    },
    async password(message: string): Promise<string> {
      assertInteractive();

      const answer = await clackPassword({
        message,
        input: process.stdin,
        output: process.stdout,
      });

      if (isCancel(answer)) {
        clackCancel("Cancelled.");
        throw new Error("Cancelled.");
      }

      return answer.trim();
    },
  };
}

export const defaultCommandRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const message = error.message || "command failed to start";
      resolve({ code: 127, stdout, stderr: `${stderr}${message}` });
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
