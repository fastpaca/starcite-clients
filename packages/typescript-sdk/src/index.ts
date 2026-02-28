import { StarciteClient } from "./client";
import type { StarciteClientOptions } from "./types";

// biome-ignore lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API.
export {
  StarciteClient,
  StarciteSession,
  toApiBaseUrl,
} from "./client";
export type { CursorStoreOptions, StarciteWebStorage } from "./cursor-store";
export {
  createInMemoryCursorStore,
  createLocalStorageCursorStore,
  createWebStorageCursorStore,
} from "./cursor-store";
export type { StarciteTailErrorStage } from "./errors";
export {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
  StarciteTailError,
} from "./errors";
export type {
  AppendEventRequest,
  AppendEventResponse,
  CreateSessionInput,
  IssueSessionTokenInput,
  IssueSessionTokenResponse,
  RequestOptions,
  SessionAppendInput,
  SessionConsumeOptions,
  SessionConsumeRawOptions,
  SessionCursorStore,
  SessionEvent,
  SessionEventBatch,
  SessionListItem,
  SessionListOptions,
  SessionListPage,
  SessionRecord,
  SessionTailOptions,
  SessionTokenPrincipal,
  SessionTokenScope,
  StarciteClientOptions,
  StarciteErrorPayload,
  StarciteWebSocket,
  StarciteWebSocketAuthTransport,
  StarciteWebSocketCloseEvent,
  StarciteWebSocketConnectOptions,
  StarciteWebSocketEventMap,
  StarciteWebSocketFactory,
  StarciteWebSocketMessageEvent,
  TailEvent,
  TailEventBatch,
  TailLifecycleEvent,
  TailReconnectPolicy,
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
