/* biome-ignore-all lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API. */
export { Starcite } from "./client";
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
  SessionStoreOptions,
  StarciteWebStorage,
  WebStorageSessionStoreOptions,
} from "./session-store";
export {
  LocalStorageSessionStore,
  MemoryStore,
  WebStorageSessionStore,
} from "./session-store";
export type {
  AppendEventRequest,
  AppendEventResponse,
  AppendResult,
  RequestOptions,
  SessionAppendInput,
  SessionEvent,
  SessionEventContext,
  SessionEventListener,
  SessionEventPhase,
  SessionListItem,
  SessionListOptions,
  SessionListPage,
  SessionLogOptions,
  SessionOnEventOptions,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionStoreMetadata,
  SessionStoreState,
  SessionTailItem,
  SessionTailIteratorOptions,
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
