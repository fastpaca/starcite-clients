/* biome-ignore-all lint/performance/noBarrelFile: package entrypoint intentionally re-exports public API. */
export { Starcite } from "./client";
export type { StarciteTailErrorStage } from "./errors";
export {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "./errors";
export type { PrincipalType } from "./identity";
export { StarciteIdentity } from "./identity";
export { StarciteSession } from "./session";
export type {
  SessionStoreOptions,
  StarciteWebStorage,
  WebStorageSessionStoreOptions,
} from "./session-store";
export {
  LocalStorageSessionStore,
  MemorySessionStore,
  SessionStorageSessionStore,
  WebStorageSessionStore,
} from "./session-store";
export type {
  AppendEventRequest,
  AppendEventResponse,
  AppendResult,
  LifecycleEventEnvelope,
  RequestOptions,
  SessionActivatedLifecycleEvent,
  SessionAppendFailureSnapshot,
  SessionAppendInput,
  SessionAppendLifecycleEvent,
  SessionAppendListener,
  SessionAppendOptions,
  SessionAppendQueueState,
  SessionAppendQueueStatus,
  SessionAppendRetryPolicy,
  SessionArchivedFilter,
  SessionArchivedLifecycleEvent,
  SessionAttachMode,
  SessionCreatedLifecycleEvent,
  SessionEventContext,
  SessionEventListener,
  SessionEventPhase,
  SessionFreezingLifecycleEvent,
  SessionFrozenLifecycleEvent,
  SessionGapListener,
  SessionHandle,
  SessionHydratingLifecycleEvent,
  SessionLifecycleEvent,
  SessionLifecycleEventName,
  SessionListItem,
  SessionListOptions,
  SessionListPage,
  SessionOnEventOptions,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionStoredAppend,
  SessionTokenRefreshContext,
  SessionTokenRefreshHandler,
  SessionTokenRefreshReason,
  SessionUnarchivedLifecycleEvent,
  SessionUpdatedLifecycleEvent,
  SessionUpdateInput,
  StarciteOptions,
  TailCursor,
  TailEvent,
  TailGap,
} from "./types";
