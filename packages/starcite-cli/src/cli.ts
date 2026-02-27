import { createStarciteClient, StarciteApiError } from "@starcite/sdk";
import { Command } from "commander";
import { createConsola } from "consola";
import starciteCliPackage from "../package.json";
import type {
  CliDependencies,
  CommandRegistrationContext,
  LoggerLike,
} from "./cli-types";
import { registerEventCommands } from "./commands/events";
import { registerRuntimeCommands } from "./commands/runtime";
import { registerSessionsCommands } from "./commands/sessions";
import { registerSetupCommands } from "./commands/setup";
import { createDefaultPrompt, defaultCommandRunner } from "./up";

export type { LoggerLike } from "./cli-types";

const defaultLogger: LoggerLike = createConsola();
const cliVersion = starciteCliPackage.version;

export function buildProgram(deps: CliDependencies = {}): Command {
  const createClient =
    deps.createClient ??
    ((baseUrl: string, apiKey?: string) =>
      createStarciteClient({
        baseUrl,
        apiKey,
      }));

  const context: CommandRegistrationContext = {
    createClient,
    logger: deps.logger ?? defaultLogger,
    prompt: deps.prompt ?? createDefaultPrompt(),
    runCommand: deps.runCommand ?? defaultCommandRunner,
    cliVersion,
  };

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

  registerSetupCommands(program, context);
  registerSessionsCommands(program, context);
  registerRuntimeCommands(program, context);
  registerEventCommands(program, context);

  return program;
}

export async function run(
  argv = process.argv,
  deps: CliDependencies = {}
): Promise<void> {
  const program = buildProgram(deps);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const logger = deps.logger ?? defaultLogger;

    if (error instanceof StarciteApiError) {
      logger.error(`${error.code} (${error.status}): ${error.message}`);
      process.exitCode = 1;
      return;
    }

    if (error instanceof Error) {
      logger.error(error.message);
      process.exitCode = 1;
      return;
    }

    logger.error("Unknown error");
    process.exitCode = 1;
  }
}
