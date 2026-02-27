import type { StarciteClient } from "@starcite/sdk";
import type { StarciteCliStore } from "./store";
import type { CommandRunner, PromptAdapter } from "./up";

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

export interface CliDependencies {
  createClient?: (baseUrl: string, apiKey?: string) => StarciteClient;
  logger?: LoggerLike;
  prompt?: PromptAdapter;
  runCommand?: CommandRunner;
}

export interface CommandRegistrationContext {
  createClient: (baseUrl: string, apiKey?: string) => StarciteClient;
  logger: LoggerLike;
  prompt: PromptAdapter;
  runCommand: CommandRunner;
  cliVersion: string;
}

export type CliJsonObject = Record<string, unknown>;

export interface AppendCommandOptions {
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

export type ResolvedAppendMode =
  | { kind: "high-level"; agent: string; text: string }
  | { kind: "raw"; actor: string; payload: string };
