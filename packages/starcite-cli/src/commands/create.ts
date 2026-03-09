import {
  type CliRuntime,
  type GlobalOptions,
  parseArgs,
  parseJsonObject,
} from "../runtime";

const DEFAULT_CREATE_AGENT_ID = "starcite-cli";

export async function runCreateCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const parsed = parseArgs(
    {
      "--id": String,
      "--title": String,
      "--metadata": String,
    },
    args
  );
  const metadata = parsed["--metadata"]
    ? parseJsonObject(parsed["--metadata"], "--metadata")
    : undefined;
  const resolved = await runtime.resolveGlobalOptions(globalOptions);
  const session = await resolved.client.session({
    identity: resolved.client.agent({ id: DEFAULT_CREATE_AGENT_ID }),
    id: parsed["--id"],
    title: parsed["--title"],
    metadata,
  });

  if (resolved.json) {
    runtime.writeJsonOutput(session.record ?? { id: session.id }, true);
    return;
  }

  runtime.logger.info(session.id);
}
