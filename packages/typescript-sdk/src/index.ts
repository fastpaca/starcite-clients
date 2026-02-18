import { StarciteClient } from "./client";
import type { StarciteClientOptions, StarcitePayload } from "./types";

// biome-ignore lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API.
export { normalizeBaseUrl, StarciteClient, StarciteSession } from "./client";
export {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "./errors";
export type {
  AppendEventRequest,
  AppendEventResponse,
  CreateSessionInput,
  SessionAppendInput,
  SessionEvent,
  SessionListItem,
  SessionListOptions,
  SessionListPage,
  SessionRecord,
  SessionTailOptions,
  StarciteClientOptions,
  StarciteErrorPayload,
  StarcitePayload,
  StarcitePayloadSchema,
  StarciteWebSocket,
  StarciteWebSocketConnectOptions,
  StarciteWebSocketFactory,
  TailEvent,
} from "./types";
/**
 * Creates a new {@link StarciteClient} instance.
 */
export function createStarciteClient<
  TPayload extends StarcitePayload = StarcitePayload,
>(options: StarciteClientOptions<TPayload> = {}): StarciteClient<TPayload> {
  return new StarciteClient<TPayload>(options);
}

/**
 * Default singleton client using environment/default configuration.
 */
export const starcite = createStarciteClient();
