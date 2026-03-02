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
export { MemoryStore } from "./session-store";
export type {
  AppendEventRequest,
  AppendEventResponse,
  AppendResult,
  CreateSessionInput,
  RequestOptions,
  SessionAppendInput,
  SessionConsumeOptions,
  SessionCursorStore,
  SessionEvent,
  SessionListItem,
  SessionListOptions,
  SessionListPage,
  SessionLogOptions,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionStoreState,
  SessionTailOptions,
  SessionTokenScope,
  StarciteOptions,
  StarciteWebSocket,
  StarciteWebSocketCloseEvent,
  StarciteWebSocketEventMap,
  StarciteWebSocketFactory,
  StarciteWebSocketMessageEvent,
  TailEvent,
  TailEventBatch,
  TailLifecycleEvent,
  TailReconnectPolicy,
} from "./types";
