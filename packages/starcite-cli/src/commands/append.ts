import type { StarciteIdentity } from "@starcite/sdk";
import {
  type CliRuntime,
  CliUsageError,
  type GlobalOptions,
  parseArgs,
  parseJsonObject,
  parseNonNegativeInteger,
  trimString,
} from "../runtime";

const DEFAULT_CREATE_AGENT_ID = "starcite-cli";

interface AppendIdentitySelection {
  type: "agent" | "user";
  id: string;
}

function resolveAppendIdentity(
  selection: AppendIdentitySelection | undefined,
  client: {
    agent(input: { id: string }): StarciteIdentity;
    user(input: { id: string }): StarciteIdentity;
  }
): StarciteIdentity {
  if (!selection) {
    return client.agent({ id: DEFAULT_CREATE_AGENT_ID });
  }

  return selection.type === "agent"
    ? client.agent({ id: selection.id })
    : client.user({ id: selection.id });
}

export async function runAppendCommand(
  args: string[],
  globalOptions: GlobalOptions,
  runtime: CliRuntime
): Promise<void> {
  const parsed = parseArgs(
    {
      "--agent": String,
      "--user": String,
      "--text": String,
      "--type": String,
      "--source": String,
      "--payload": String,
      "--metadata": String,
      "--refs": String,
      "--idempotency-key": String,
      "--expected-seq": String,
    },
    args
  );
  const sessionId = `${parsed._[0] ?? ""}`;

  if (!sessionId) {
    throw new CliUsageError("append requires <sessionId>");
  }

  const agent = trimString(parsed["--agent"]);
  const user = trimString(parsed["--user"]);
  const text = trimString(parsed["--text"]);
  const payload = parsed["--payload"]
    ? parseJsonObject(parsed["--payload"], "--payload")
    : undefined;

  if (agent && user) {
    throw new CliUsageError("Choose either --agent or --user, not both");
  }

  if (text && payload) {
    throw new CliUsageError("Choose either --text or --payload, not both");
  }

  if (!(text || payload)) {
    throw new CliUsageError("append requires either --text or --payload");
  }

  let identity: AppendIdentitySelection | undefined;
  if (agent) {
    identity = { type: "agent", id: agent };
  } else if (user) {
    identity = { type: "user", id: user };
  }

  const resolved = await runtime.resolveGlobalOptions(globalOptions);
  const session = await resolved.client.session({
    identity: resolveAppendIdentity(identity, resolved.client),
    id: sessionId,
  });
  const response = await session.append({
    type: parsed["--type"] ?? "content",
    payload: payload ?? { text },
    source: parsed["--source"],
    metadata: parsed["--metadata"]
      ? parseJsonObject(parsed["--metadata"], "--metadata")
      : undefined,
    refs: parsed["--refs"]
      ? parseJsonObject(parsed["--refs"], "--refs")
      : undefined,
    idempotencyKey: parsed["--idempotency-key"],
    expectedSeq: parsed["--expected-seq"]
      ? parseNonNegativeInteger(parsed["--expected-seq"], "--expected-seq")
      : undefined,
  });

  if (resolved.json) {
    runtime.writeJsonOutput(response, true);
    return;
  }

  runtime.logger.info(`seq=${response.seq} deduped=${response.deduped}`);
}
