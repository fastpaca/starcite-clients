// biome-ignore lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API.
export { Starcite } from "./client";
export type { CursorStoreOptions, StarciteWebStorage } from "./cursor-store";
export {
  InMemoryCursorStore,
  LocalStorageCursorStore,
  WebStorageCursorStore,
} from "./cursor-store";
export type { StarciteTailErrorStage } from "./errors";
export {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
  StarciteTailError,
} from "./errors";
export { StarciteIdentity } from "./identity";
export type { PrincipalType } from "./identity";
export { StarciteSession } from "./session";
export { toApiBaseUrl } from "./transport";
export type {
  AppendEventRequest,
  AppendEventResponse,
  RequestOptions,
  SessionAppendInput,
  SessionConsumeOptions,
  SessionCursorStore,
  SessionListItem,
  SessionListOptions,
  SessionListPage,
  SessionRecord,
  SessionTailOptions,
  SessionTokenScope,
  StarciteErrorPayload,
  StarciteOptions,
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
