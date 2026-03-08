import { type Command, InvalidArgumentError } from "commander";
import {
  type AppendCommandOptions,
  type AppendIdentitySelection,
  type CliJsonObject,
  type CliRuntime,
  parseJsonObject,
  parseNonNegativeInteger,
  trimString,
} from "../runtime";

interface ResolvedAppendInput {
  identity?: AppendIdentitySelection;
  payload: CliJsonObject;
}

function resolveAppendInput(
  options: AppendCommandOptions
): ResolvedAppendInput {
  const agent = trimString(options.agent);
  const user = trimString(options.user);

  if (agent && user) {
    throw new InvalidArgumentError("Choose either --agent or --user, not both");
  }

  const text = trimString(options.text);
  const payload = trimString(options.payload);

  if (text && payload) {
    throw new InvalidArgumentError(
      "Choose either --text or --payload, not both"
    );
  }

  if (!(text || payload)) {
    throw new InvalidArgumentError(
      "append requires either --text or --payload"
    );
  }

  let identity: AppendIdentitySelection | undefined;
  if (agent) {
    identity = { type: "agent", id: agent };
  } else if (user) {
    identity = { type: "user", id: user };
  }

  if (text) {
    return {
      identity,
      payload: { text },
    };
  }

  if (!payload) {
    throw new InvalidArgumentError(
      "append requires either --text or --payload"
    );
  }

  return {
    identity,
    payload: parseJsonObject(payload, "--payload"),
  };
}

export function registerAppendCommand(
  program: Command,
  runtime: CliRuntime
): void {
  program
    .command("append <sessionId>")
    .description("Append an event")
    .option("--agent <agent>", "Append as agent identity")
    .option("--user <user>", "Append as user identity")
    .option("--text <text>", 'Text content shorthand for {"text": ...}')
    .option("--type <type>", "Event type", "content")
    .option("--source <source>", "Event source")
    .option("--payload <json>", "JSON payload object")
    .option("--metadata <json>", "Event metadata JSON object")
    .option("--refs <json>", "Event refs JSON object")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--expected-seq <seq>", "Expected sequence", (value) =>
      parseNonNegativeInteger(value, "--expected-seq")
    )
    .action(async function (
      this: Command,
      sessionId: string,
      options: AppendCommandOptions
    ) {
      const resolved = await runtime.resolveGlobalOptions(this);
      const client = runtime.createSdkClient(resolved);
      const metadata = options.metadata
        ? parseJsonObject(options.metadata, "--metadata")
        : undefined;
      const refs = options.refs
        ? parseJsonObject(options.refs, "--refs")
        : undefined;
      const appendInput = resolveAppendInput(options);
      const session = appendInput.identity
        ? await runtime.resolveAppendSession({
            client,
            store: resolved.store,
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
            sessionId,
            identity: appendInput.identity,
          })
        : await runtime.resolveSession(client, resolved.apiKey, sessionId);

      const response = await session.append({
        type: options.type,
        payload: appendInput.payload,
        metadata,
        refs,
        source: options.source,
        idempotencyKey: options.idempotencyKey,
        expectedSeq: options.expectedSeq,
      });

      if (resolved.json) {
        runtime.writeJsonOutput(response, true);
        return;
      }

      runtime.logger.info(`seq=${response.seq} deduped=${response.deduped}`);
    });
}
