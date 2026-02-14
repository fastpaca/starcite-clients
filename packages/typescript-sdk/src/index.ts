import { StarciteClient } from "./client";
import type { StarciteClientOptions } from "./types";

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
  StarciteWebSocket,
  StarciteWebSocketConnectOptions,
  StarciteWebSocketFactory,
  TailEvent,
} from "./types";
/**
 * Creates a new {@link StarciteClient} instance.
 */
export function createStarciteClient(
  options: StarciteClientOptions = {}
): StarciteClient {
  return new StarciteClient(options);
}

/**
 * Default singleton client using environment/default configuration.
 */
export const starcite = createStarciteClient();
