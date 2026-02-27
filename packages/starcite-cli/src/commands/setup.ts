import { Command, InvalidArgumentError } from "commander";
import {
  parseConfigSetKey,
  parseEndpoint,
  promptForApiKey,
  promptForEndpoint,
  trimString,
  withResolvedGlobals,
} from "../cli-core";
import type { CommandRegistrationContext } from "../cli-types";

export function registerSetupCommands(
  program: Command,
  context: CommandRegistrationContext
): void {
  const { cliVersion, logger, prompt } = context;

  program
    .command("version")
    .description("Print current CLI version")
    .action(() => {
      logger.info(cliVersion);
    });

  program
    .command("init")
    .description("Initialize Starcite CLI config for a remote instance")
    .option("--endpoint <url>", "Starcite endpoint URL")
    .option("--api-key <key>", "API key to store")
    .option("-y, --yes", "Skip prompts and only use provided options")
    .action(
      withResolvedGlobals(
        async (
          { baseUrl, json, store },
          options: {
            endpoint?: string;
            apiKey?: string;
            yes?: boolean;
          }
        ) => {
          const defaultEndpoint = parseEndpoint(baseUrl, "endpoint");
          let endpoint = defaultEndpoint;

          if (options.endpoint) {
            endpoint = parseEndpoint(options.endpoint, "--endpoint");
          } else if (!options.yes) {
            endpoint = await promptForEndpoint(prompt, defaultEndpoint);
          }

          await store.updateConfig({ baseUrl: endpoint });

          let apiKey = trimString(options.apiKey);

          if (!(apiKey || options.yes)) {
            apiKey = await promptForApiKey(prompt);
          }

          if (apiKey) {
            await store.saveApiKey(apiKey);
            await store.updateConfig({ apiKey: undefined });
          }

          if (json) {
            logger.info(
              JSON.stringify(
                {
                  configDir: store.directory,
                  endpoint,
                  apiKeySaved: Boolean(apiKey),
                },
                null,
                2
              )
            );
            return;
          }

          logger.info(`Initialized Starcite CLI in ${store.directory}`);
          logger.info(`Endpoint set to ${endpoint}`);
          if (apiKey) {
            logger.info("API key saved.");
          } else {
            logger.info(
              "API key not set. Run `starcite auth login` when ready."
            );
          }
        }
      )
    );

  program
    .command("config")
    .description("Manage CLI configuration")
    .addCommand(
      new Command("set")
        .description("Set a configuration value")
        .argument("<key>", "endpoint | producer-id | api-key")
        .argument("<value>", "value to store")
        .action(
          withResolvedGlobals(async ({ store }, key: string, value: string) => {
            const parsedKey = parseConfigSetKey(key);

            if (parsedKey === "endpoint") {
              const endpoint = parseEndpoint(value, "endpoint");
              await store.updateConfig({ baseUrl: endpoint });
              logger.info(`Endpoint set to ${endpoint}`);
              return;
            }

            if (parsedKey === "producer-id") {
              const producerId = trimString(value);
              if (!producerId) {
                throw new InvalidArgumentError("producer-id cannot be empty");
              }

              await store.updateConfig({ producerId });
              logger.info(`Producer ID set to ${producerId}`);
              return;
            }

            await store.saveApiKey(value);
            await store.updateConfig({ apiKey: undefined });
            logger.info("API key saved.");
          })
        )
    )
    .addCommand(
      new Command("show").description("Show current configuration").action(
        withResolvedGlobals(async ({ baseUrl, store }) => {
          const config = await store.readConfig();
          const apiKey = await store.readApiKey();
          const fromEnv = trimString(process.env.STARCITE_API_KEY);
          let apiKeySource = "unset";

          if (fromEnv) {
            apiKeySource = "env";
          } else if (apiKey) {
            apiKeySource = "stored";
          }

          logger.info(
            JSON.stringify(
              {
                endpoint: config.baseUrl ?? baseUrl,
                producerId: config.producerId ?? null,
                apiKey: apiKey ? "***" : null,
                apiKeySource,
                configDir: store.directory,
              },
              null,
              2
            )
          );
        })
      )
    );

  program
    .command("auth")
    .description("Manage API key authentication")
    .addCommand(
      new Command("login")
        .description("Save an API key for authenticated requests")
        .option("--api-key <key>", "API key to store")
        .action(
          withResolvedGlobals(
            async ({ store }, options: { apiKey?: string }) => {
              let apiKey = trimString(options.apiKey);

              if (!apiKey) {
                apiKey = await promptForApiKey(prompt);
              }

              if (!apiKey) {
                throw new InvalidArgumentError("API key cannot be empty");
              }

              await store.saveApiKey(apiKey);
              await store.updateConfig({ apiKey: undefined });
              logger.info("API key saved.");
            }
          )
        )
    )
    .addCommand(
      new Command("logout").description("Remove the saved API key").action(
        withResolvedGlobals(async ({ store }) => {
          await store.clearApiKey();
          logger.info("Saved API key removed.");
        })
      )
    )
    .addCommand(
      new Command("status").description("Show authentication status").action(
        withResolvedGlobals(async ({ store }) => {
          const apiKey = await store.readApiKey();
          const fromEnv = trimString(process.env.STARCITE_API_KEY);

          if (fromEnv) {
            logger.info("Authenticated via STARCITE_API_KEY.");
            return;
          }

          if (apiKey) {
            logger.info("Authenticated via saved API key.");
            return;
          }

          logger.info("No API key configured. Run `starcite auth login`.");
        })
      )
    );
}
