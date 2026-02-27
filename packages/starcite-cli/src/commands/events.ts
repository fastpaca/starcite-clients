import { toApiBaseUrl } from "@starcite/sdk";
import type { Command } from "commander";
import {
  appendHighLevel,
  appendRaw,
  DEFAULT_TAIL_BATCH_SIZE,
  formatTailEvent,
  parseEventRefs,
  parseJsonObject,
  parseNonNegativeInteger,
  parsePositiveInteger,
  resolveAppendMode,
  resolveSessionClient,
  withResolvedGlobals,
} from "../cli-core";
import type {
  AppendCommandOptions,
  CommandRegistrationContext,
} from "../cli-types";
import { buildSeqContextKey } from "../store";

export function registerEventCommands(
  program: Command,
  context: CommandRegistrationContext
): void {
  const { createClient, logger } = context;

  program
    .command("append <sessionId>")
    .description("Append an event")
    .option("--agent <agent>", "Agent name (high-level mode)")
    .option("--text <text>", "Text content (high-level mode)")
    .option("--type <type>", "Event type", "content")
    .option("--source <source>", "Event source")
    .option(
      "--producer-id <id>",
      "Producer identity (auto-generated if omitted)"
    )
    .option(
      "--producer-seq <seq>",
      "Producer sequence (defaults to persisted state, starting at 1)",
      (value) => parsePositiveInteger(value, "--producer-seq")
    )
    .option("--actor <actor>", "Raw actor field (raw mode)")
    .option("--payload <json>", "Raw payload JSON object (raw mode)")
    .option("--metadata <json>", "Event metadata JSON object")
    .option("--refs <json>", "Event refs JSON object")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--expected-seq <seq>", "Expected sequence", (value) =>
      parseNonNegativeInteger(value, "--expected-seq")
    )
    .action(
      withResolvedGlobals(
        async (
          { baseUrl, apiKey, json, store },
          sessionId: string,
          options: AppendCommandOptions
        ) => {
          const client = await resolveSessionClient(
            createClient,
            baseUrl,
            apiKey,
            sessionId,
            ["session:append"]
          );
          const session = client.session(sessionId);

          const metadata = options.metadata
            ? parseJsonObject(options.metadata, "--metadata")
            : undefined;
          const refs = options.refs ? parseEventRefs(options.refs) : undefined;
          const mode = resolveAppendMode(options);

          const producerId = await store.resolveProducerId(options.producerId);
          const normalizedBaseUrl = toApiBaseUrl(baseUrl);
          const contextKey = buildSeqContextKey(
            normalizedBaseUrl,
            sessionId,
            producerId
          );

          const response = await store.withStateLock(async () => {
            const producerSeq =
              options.producerSeq ?? (await store.readNextSeq(contextKey));
            const appendOptions = {
              ...options,
              producerId,
              producerSeq,
            };

            const appendResponse =
              mode.kind === "high-level"
                ? await appendHighLevel(
                    session,
                    {
                      ...appendOptions,
                      agent: mode.agent,
                      text: mode.text,
                    },
                    metadata,
                    refs
                  )
                : await appendRaw(
                    session,
                    {
                      ...appendOptions,
                      actor: mode.actor,
                      payload: mode.payload,
                    },
                    metadata,
                    refs
                  );

            await store.bumpNextSeq(contextKey, producerSeq);
            return appendResponse;
          });

          if (json) {
            logger.info(JSON.stringify(response, null, 2));
            return;
          }

          logger.info(
            `seq=${response.seq} last_seq=${response.last_seq} deduped=${response.deduped}`
          );
        }
      )
    );

  program
    .command("tail <sessionId>")
    .description("Tail events from a session")
    .option("--cursor <cursor>", "Replay cursor", (value) =>
      parseNonNegativeInteger(value, "--cursor")
    )
    .option("--agent <agent>", "Filter by agent name")
    .option("--limit <count>", "Stop after N events", (value) =>
      parseNonNegativeInteger(value, "--limit")
    )
    .option("--no-follow", "Exit after replaying stored events")
    .action(
      withResolvedGlobals(
        async (
          { baseUrl, apiKey, json },
          sessionId: string,
          options: {
            cursor?: number;
            agent?: string;
            limit?: number;
            follow: boolean;
          }
        ) => {
          const client = await resolveSessionClient(
            createClient,
            baseUrl,
            apiKey,
            sessionId,
            ["session:read"]
          );
          const session = client.session(sessionId);

          const abortController = new AbortController();
          const onSigint = () => {
            abortController.abort();
          };

          process.once("SIGINT", onSigint);

          try {
            let emitted = 0;

            for await (const event of session.tail({
              cursor: options.cursor ?? 0,
              batchSize: DEFAULT_TAIL_BATCH_SIZE,
              agent: options.agent,
              follow: options.follow,
              signal: abortController.signal,
            })) {
              if (json) {
                logger.info(JSON.stringify(event));
              } else {
                logger.info(formatTailEvent(event));
              }

              emitted += 1;

              if (options.limit !== undefined && emitted >= options.limit) {
                abortController.abort();
                break;
              }
            }
          } finally {
            process.removeListener("SIGINT", onSigint);
          }
        }
      )
    );
}
