import type { Command } from "commander";
import { type CliRuntime, parsePort } from "../runtime";
import { runDownWizard, runUpWizard } from "../up";

export function registerLifecycleCommands(
  program: Command,
  runtime: CliRuntime
): void {
  program
    .command("up")
    .description("Start local Starcite services with Docker")
    .option("-y, --yes", "Skip confirmation prompts and use defaults")
    .option("--port <port>", "Starcite API port", (value) =>
      parsePort(value, "--port")
    )
    .option("--db-port <port>", "Postgres port", (value) =>
      parsePort(value, "--db-port")
    )
    .option("--image <image>", "Override Starcite image")
    .action(async function (
      this: Command,
      options: {
        yes?: boolean;
        port?: number;
        dbPort?: number;
        image?: string;
      }
    ) {
      const { baseUrl, store } = await runtime.resolveGlobalOptions(this);
      await runUpWizard({
        baseUrl,
        logger: runtime.logger,
        options,
        prompt: runtime.prompt,
        runCommand: runtime.runCommand,
        store,
      });
    });

  program
    .command("down")
    .description("Stop and remove local Starcite services")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--no-volumes", "Keep Postgres volume data")
    .action(async function (
      this: Command,
      options: { yes?: boolean; volumes?: boolean }
    ) {
      const { store } = await runtime.resolveGlobalOptions(this);
      await runDownWizard({
        logger: runtime.logger,
        options,
        prompt: runtime.prompt,
        runCommand: runtime.runCommand,
        store,
      });
    });
}
