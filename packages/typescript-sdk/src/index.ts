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
  StarciteBackpressureError,
  StarciteConnectionError,
  StarciteError,
  StarciteRetryLimitError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "./errors";
export { StarciteIdentity } from "./identity";
export type { PrincipalType } from "./identity";
export { StarciteSession } from "./session";
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
