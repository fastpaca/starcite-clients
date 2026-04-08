import { resolveConfigDir, StarciteCliConfigStore } from "../config";
import {
  type CliRuntime,
  CliUsageError,
  type GlobalOptions,
  parseConfigSetKey,
  parseEndpoint,
  resolveCliStarciteConfig,
} from "../runtime";

export async function runConfigCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const action = args[0];
  const config = new StarciteCliConfigStore(
    resolveConfigDir(globalOptions.configDir)
  );

  if (action === "set") {
    const key = args[1];
    const value = args[2];

    if (!(key && value)) {
      throw new CliUsageError("config set requires <key> and <value>");
    }

    if (parseConfigSetKey(key) === "endpoint") {
      const endpoint = parseEndpoint(value, "endpoint");
      await config.updateConfig({ baseUrl: endpoint });
      runtime.logger.info(`Endpoint set to ${endpoint}`);
      return;
    }

    await config.saveApiKey(value);
    await config.updateConfig({ apiKey: undefined });
    runtime.logger.info("API key saved.");
    return;
  }

  if (action === "show") {
    const fileConfig = await config.readConfig();
    const storedApiKey = await config.readApiKey();
    const resolved = resolveCliStarciteConfig(
      fileConfig,
      globalOptions,
      storedApiKey
    );

    const output = {
      endpoint: resolved.config.baseUrl,
      apiKey: resolved.config.apiKey ? "***" : null,
      apiKeySource: resolved.apiKeySource,
      configDir: config.directory,
    };

    if (globalOptions.json) {
      runtime.writeJsonOutput(output, true);
      return;
    }

    runtime.logger.info(JSON.stringify(output, null, 2));
    return;
  }

  throw new CliUsageError("config requires `set` or `show`");
}
