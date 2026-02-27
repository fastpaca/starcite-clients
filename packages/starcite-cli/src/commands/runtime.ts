import type { Command } from "commander";
import { parsePort, withResolvedGlobals } from "../cli-core";
import type { CommandRegistrationContext } from "../cli-types";
import { runDownWizard, runUpWizard } from "../up";

export function registerRuntimeCommands(
  program: Command,
  context: CommandRegistrationContext
): void {
  const { logger, prompt, runCommand } = context;

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
    .action(
      withResolvedGlobals(
        async (
          { baseUrl, store },
          options: {
            yes?: boolean;
            port?: number;
            dbPort?: number;
            image?: string;
          }
        ) => {
          await runUpWizard({
            baseUrl,
            logger,
            options,
            prompt,
            runCommand,
            store,
          });
        }
      )
    );

  program
    .command("down")
    .description("Stop and remove local Starcite services")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--no-volumes", "Keep Postgres volume data")
    .action(
      withResolvedGlobals(
        async ({ store }, options: { yes?: boolean; volumes?: boolean }) => {
          await runDownWizard({
            logger,
            options,
            prompt,
            runCommand,
            store,
          });
        }
      )
    );
}
