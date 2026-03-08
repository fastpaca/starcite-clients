import { StarciteApiError } from "@starcite/sdk";
import { Command } from "commander";
import starciteCliPackage from "../package.json";
import { registerAppendCommand } from "./commands/append";
import { registerConfigCommand } from "./commands/config";
import { registerCreateCommand } from "./commands/create";
import { registerLifecycleCommands } from "./commands/lifecycle";
import { registerSessionsCommand } from "./commands/sessions";
import { registerTailCommand } from "./commands/tail";
import { type CliDependencies, CliRuntime } from "./runtime";

const cliVersion = starciteCliPackage.version;

export function buildProgram(deps: CliDependencies = {}): Command {
  const runtime = new CliRuntime(deps);
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

  program
    .command("version")
    .description("Print current CLI version")
    .action(() => {
      runtime.logger.info(cliVersion);
    });

  registerConfigCommand(program, runtime);
  registerSessionsCommand(program, runtime);
  registerLifecycleCommands(program, runtime);
  registerCreateCommand(program, runtime);
  registerAppendCommand(program, runtime);
  registerTailCommand(program, runtime);

  return program;
}

export async function run(
  argv = process.argv,
  deps: CliDependencies = {}
): Promise<void> {
  const runtime = new CliRuntime(deps);
  const program = buildProgram(deps);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof StarciteApiError) {
      runtime.logger.error(`${error.code} (${error.status}): ${error.message}`);
      process.exitCode = 1;
      return;
    }

    if (error instanceof Error) {
      runtime.logger.error(error.message);
      process.exitCode = 1;
      return;
    }

    runtime.logger.error("Unknown error");
    process.exitCode = 1;
  }
}
