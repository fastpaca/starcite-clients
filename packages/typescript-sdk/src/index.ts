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
export type { PrincipalType } from "./identity";
export { StarciteIdentity } from "./identity";
export { StarciteSession } from "./session";
export { SessionLogConflictError, SessionLogGapError } from "./session-log";
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
  SessionLogOptions,
  SessionRecord,
  SessionSnapshot,
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
