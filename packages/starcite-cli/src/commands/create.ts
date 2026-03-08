import type { Command } from "commander";
import { type CliRuntime, parseJsonObject } from "../runtime";

export function registerCreateCommand(
  program: Command,
  runtime: CliRuntime
): void {
  program
    .command("create")
    .description("Create a session")
    .option("--id <id>", "Session ID")
    .option("--title <title>", "Session title")
    .option("--metadata <json>", "Session metadata JSON object")
    .action(async function (
      this: Command,
      options: {
        id?: string;
        title?: string;
        metadata?: string;
      }
    ) {
      const resolved = await runtime.resolveGlobalOptions(this);
      const client = runtime.createSdkClient(resolved);
      const metadata = options.metadata
        ? parseJsonObject(options.metadata, "--metadata")
        : undefined;
      const session = await client.session({
        identity: runtime.resolveCreateIdentity(resolved.apiKey),
        id: options.id,
        title: options.title,
        metadata,
      });

      if (resolved.json) {
        runtime.writeJsonOutput(session.record ?? { id: session.id }, true);
        return;
      }

      runtime.logger.info(session.id);
    });
}
