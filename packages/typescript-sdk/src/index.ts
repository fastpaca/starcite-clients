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
  EventRefs,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  SessionAppendInput,
  SessionEvent,
  SessionRecord,
  SessionTailOptions,
  StarciteClientOptions,
  StarciteErrorPayload,
  StarciteWebSocket,
  StarciteWebSocketFactory,
  TailEvent,
} from "./types";

export function createStarciteClient(
  options: StarciteClientOptions = {}
): StarciteClient {
  return new StarciteClient(options);
}

export const starcite = createStarciteClient();
