import { Command } from "commander";
import {
  type CliRuntime,
  parseConfigSetKey,
  parseEndpoint,
  trimString,
} from "../runtime";

export function registerConfigCommand(
  program: Command,
  runtime: CliRuntime
): void {
  program
    .command("config")
    .description("Manage CLI configuration")
    .addCommand(
      new Command("set")
        .description("Set a configuration value")
        .argument("<key>", "endpoint | api-key")
        .argument("<value>", "value to store")
        .action(async function (this: Command, key: string, value: string) {
          const { store } = await runtime.resolveGlobalOptions(this);
          const parsedKey = parseConfigSetKey(key);

          if (parsedKey === "endpoint") {
            const endpoint = parseEndpoint(value, "endpoint");
            await store.updateConfig({ baseUrl: endpoint });
            runtime.logger.info(`Endpoint set to ${endpoint}`);
            return;
          }

          await store.saveApiKey(value);
          await store.updateConfig({ apiKey: undefined });
          runtime.logger.info("API key saved.");
        })
    )
    .addCommand(
      new Command("show")
        .description("Show current configuration")
        .action(async function (this: Command) {
          const { baseUrl, json, store } =
            await runtime.resolveGlobalOptions(this);
          const config = await store.readConfig();
          const apiKey = await store.readApiKey();
          const fromEnv = trimString(process.env.STARCITE_API_KEY);
          let apiKeySource = "unset";

          if (fromEnv) {
            apiKeySource = "env";
          } else if (apiKey) {
            apiKeySource = "stored";
          }

          const output = {
            endpoint: config.baseUrl ?? baseUrl,
            apiKey: apiKey ? "***" : null,
            apiKeySource,
            configDir: store.directory,
          };

          if (json) {
            runtime.writeJsonOutput(output, true);
            return;
          }

          runtime.logger.info(JSON.stringify(output, null, 2));
        })
    );
}
