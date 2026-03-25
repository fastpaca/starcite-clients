/* biome-ignore-all lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API. */
export { Starcite } from "./client";
export type { StarciteTailErrorStage } from "./errors";
export {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
  StarciteTailError,
  StarciteTailGapError,
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
  SessionAppendFailureSnapshot,
  SessionAppendInput,
  SessionAppendLifecycleEvent,
  SessionAppendListener,
  SessionAppendOptions,
  SessionAppendQueueState,
  SessionAppendQueueStatus,
  SessionAppendRetryPolicy,
  SessionEvent,
  SessionEventContext,
  SessionEventListener,
  SessionEventPhase,
  SessionGapListener,
  SessionListItem,
  SessionListOptions,
  SessionListPage,
  SessionLogOptions,
  SessionOnEventOptions,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionStoredAppend,
  SessionStoreMetadata,
  SessionStoreState,
  SessionTokenScope,
  StarciteOptions,
  TailCursor,
  TailEvent,
  TailGap,
} from "./types";
